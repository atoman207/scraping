/**
 * Supabase を使ったジョブキュー。
 *
 * 従来の lib/jobs.ts はメモリ上にしか状態を持たず、
 *   - サーバー再起動で消える
 *   - Vercel のようなサーバーレスでは、起動したジョブの進捗を次のリクエストで見られない
 * という制約があった。
 *
 * この構成では役割を分ける:
 *   画面(Vercel)   … enqueue() で1行入れる / getJob() でポーリングするだけ。ブラウザは動かさない
 *   ワーカー(常駐)  … claimJob() で拾い、Playwright で実行し、進捗と結果を書き戻す
 *
 * こうする理由は、スクレイピングには実ブラウザ(Playwright)と数分〜十数分の実行時間が
 * 必要で、Vercelのサーバーレス関数ではどちらも満たせないため(実行時間の上限があり、
 * ブラウザのバイナリも同梱できない)。
 */
import { getSupabase, must } from "./supabase";

export type JobKind = "search" | "seller" | "sourcing";
export type JobStatus = "queued" | "running" | "done" | "error" | "canceled";

/** 進捗。画面はこれを見て「今どの段階か」を出す */
export type JobProgress = {
  /** crawl=巡回中 / names=セラー名取得中 / aggregate=集計中 / save=保存中 / deep=深掘り中 / ship=送料取得中 */
  phase: "crawl" | "names" | "aggregate" | "save" | "deep" | "ship";
  /** 何件目か(1始まり) */
  i?: number;
  /** 全体件数 */
  n?: number;
  /** 今処理しているものの名前(キーワードやセラーID) */
  label?: string;
};

export type Job = {
  id: number;
  seq: number | null;
  kind: JobKind;
  params: Record<string, unknown>;
  label: string | null;
  status: JobStatus;
  progress: JobProgress | null;
  log: string[];
  result: Record<string, unknown> | null;
  result_href: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

/** ログはDBに貯めすぎないよう、直近この件数だけ残す */
const LOG_KEEP = 300;

/** ジョブを1件積む。画面側(Vercel)はこれだけを呼ぶ */
export async function enqueue(kind: JobKind, params: Record<string, unknown>, label: string): Promise<Job> {
  const row = must(
    await getSupabase()
      .from("jobs")
      .insert({ kind, params, label, status: "queued" })
      .select("*")
      .single()
  ) as Job;
  return row;
}

export async function getJob(id: number): Promise<Job | null> {
  const row = must(await getSupabase().from("jobs").select("*").eq("id", id).maybeSingle()) as Job | null;
  return row;
}

/** 履歴一覧(新しい順) */
export async function listJobs(limit = 30, kind?: JobKind): Promise<Job[]> {
  let q = getSupabase().from("jobs").select("*").order("created_at", { ascending: false }).limit(limit);
  if (kind) q = q.eq("kind", kind);
  return (must(await q) ?? []) as Job[];
}

/** 自分の前に何件待っているか */
export async function queueAhead(id: number): Promise<number> {
  const res = await getSupabase().rpc("queue_ahead", { job_id: id });
  if (res.error) return 0;
  return Number(res.data ?? 0);
}

/**
 * 待っているジョブを1件取り出して running にする(ワーカー用)。
 * 同時に複数のワーカーが動いても二重取得しないよう、DB側でロックしている。
 */
export async function claimJob(workerId: string): Promise<Job | null> {
  const res = await getSupabase().rpc("claim_job", { worker_id: workerId });
  if (res.error) throw new Error(`ジョブの取得に失敗: ${res.error.message}`);
  const rows = (res.data ?? []) as Job[];
  return rows.length ? rows[0] : null;
}

/** 進捗とログを書き戻す。ワーカーが生きていることの通知(heartbeat)も兼ねる */
export async function updateProgress(
  id: number,
  patch: { progress?: JobProgress; appendLog?: string }
): Promise<void> {
  const sb = getSupabase();
  const update: Record<string, unknown> = { heartbeat_at: new Date().toISOString() };
  if (patch.progress) update.progress = patch.progress;

  if (patch.appendLog) {
    // ログは配列の末尾に足す。長くなりすぎないよう直近だけ残す
    const cur = must(await sb.from("jobs").select("log").eq("id", id).maybeSingle()) as { log: string[] } | null;
    const next = [...(cur?.log ?? []), patch.appendLog];
    update.log = next.length > LOG_KEEP ? next.slice(next.length - LOG_KEEP) : next;
  }
  must(await sb.from("jobs").update(update).eq("id", id).select("id"));
}

export async function finishJob(
  id: number,
  patch: { status: "done" | "error" | "canceled"; result?: Record<string, unknown>; resultHref?: string; error?: string }
): Promise<void> {
  must(
    await getSupabase()
      .from("jobs")
      .update({
        status: patch.status,
        result: patch.result ?? null,
        result_href: patch.resultHref ?? null,
        error: patch.error ?? null,
        finished_at: new Date().toISOString(),
        progress: null,
      })
      .eq("id", id)
      .select("id")
  );
}

/** 履歴を1件消す(実行中は消させない) */
export async function removeJob(id: number): Promise<boolean> {
  const res = must(
    await getSupabase().from("jobs").delete().eq("id", id).in("status", ["done", "error", "canceled"]).select("id")
  ) as { id: number }[] | null;
  return Boolean(res?.length);
}
