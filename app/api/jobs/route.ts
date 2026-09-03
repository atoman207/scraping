/**
 * ジョブの受付と参照。
 *
 *   POST /api/jobs   { kind, ...params }  → { jobId, seq }   ジョブを積むだけ
 *   GET  /api/jobs?id=123                 → ジョブ1件(進捗・ログ・結果)
 *   GET  /api/jobs?limit=30               → 履歴一覧
 *   DELETE /api/jobs?id=123               → 履歴を1件削除(実行中は不可)
 *
 * ここでは**スクレイピングを実行しない**。実行するのは常駐ワーカー(scripts/worker.ts)。
 * 理由: スクレイピングには実ブラウザと数分〜十数分の実行時間が必要で、
 *       Vercelのサーバーレス関数では実行時間の上限を超え、ブラウザも同梱できないため。
 *       このルートはVercel上で問題なく動く(DBに1行入れて読むだけ)。
 */
import { NextRequest, NextResponse } from "next/server";
import { enqueue, getJob, listJobs, queueAhead, removeJob, type JobKind } from "../../../lib/jobs-db";

export const dynamic = "force-dynamic";

const KINDS: JobKind[] = ["search", "seller", "sourcing"];

function clamp(n: number, lo: number, hi: number) {
  return Math.min(Math.max(Number.isFinite(n) ? n : lo, lo), hi);
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "JSONを解釈できませんでした" }, { status: 400 });
  }

  const kind = String(body.kind ?? "") as JobKind;
  if (!KINDS.includes(kind)) {
    return NextResponse.json({ error: `kind は ${KINDS.join(" / ")} のいずれかです` }, { status: 400 });
  }

  if (kind === "search") {
    const keyword = String(body.keyword ?? "").trim();
    if (!keyword) return NextResponse.json({ error: "キーワードを入力してください" }, { status: 400 });

    const aruaru = Array.isArray(body.aruaru)
      ? [...new Set((body.aruaru as unknown[]).map((w) => String(w).trim()).filter(Boolean))]
      : [];
    const pages = clamp(Number(body.pages ?? 10), 1, 20);
    const sellers = clamp(Number(body.sellers ?? 60), 1, 200);
    const includeUsed = Boolean(body.includeUsed);

    const label =
      `リサーチ：${keyword}` +
      (aruaru.length ? ` [${aruaru.join("、")}]` : "") +
      `（${pages}ページ${includeUsed ? "・中古含む" : ""}）`;

    const job = await enqueue(kind, { keyword, aruaru, pages, sellers, includeUsed }, label);
    return NextResponse.json({ jobId: job.id, seq: job.seq, label });
  }

  // 3-2 / 3-3 はワーカー側の実装が済み次第ここに追加する
  return NextResponse.json({ error: `${kind} はまだ受け付けていません` }, { status: 400 });
}

export async function GET(req: NextRequest) {
  const idParam = req.nextUrl.searchParams.get("id");
  if (idParam) {
    const job = await getJob(Number(idParam));
    if (!job) return NextResponse.json({ error: "見つかりません" }, { status: 404 });
    // 順番待ちのときだけ「あなたの前に何件」を付ける
    const ahead = job.status === "queued" ? await queueAhead(job.id) : 0;
    return NextResponse.json({ job, queueAhead: ahead });
  }
  const limit = clamp(Number(req.nextUrl.searchParams.get("limit") ?? 30), 1, 100);
  const kindParam = req.nextUrl.searchParams.get("kind");
  const kind = KINDS.includes(kindParam as JobKind) ? (kindParam as JobKind) : undefined;
  return NextResponse.json({ jobs: await listJobs(limit, kind) });
}

export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isFinite(id)) return NextResponse.json({ error: "id が不正です" }, { status: 400 });
  const ok = await removeJob(id);
  if (!ok) return NextResponse.json({ error: "実行中のジョブは削除できません" }, { status: 409 });
  return NextResponse.json({ ok: true });
}
