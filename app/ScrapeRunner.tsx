"use client";

/**
 * スクレイパーを画面から起動し、進捗をポーリングして表示するパネル。
 * 実行そのものは /api/scrape がサーバー側で行う。
 *
 * 待ち時間の扱い:
 *   メルカリへのアクセスは1回2.5〜5秒の間隔を空けるので、検索は数十秒〜数分かかる。
 *   その間ずっと「実行中…」だけだと、止まっているのか進んでいるのか分からない。
 *   そこで **段階(どこまで来たか)・進捗バー・経過時間・流れるログ** の4つを出す。
 *   どれもサーバーが返す構造化された進捗(lib/jobs.ts の JobProgress)に基づいていて、
 *   実態の無いアニメーションで進んでいるように見せてはいない。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { IconAlert, IconArrowRight, IconCheck, IconLoader, IconRefresh, IconSearch } from "./icons";

type Phase = "crawl" | "names" | "list" | "ship" | "aggregate" | "save" | "cluster" | "title" | "image";

type Progress = { phase: Phase; done?: number; total?: number; label?: string };

type Job = {
  id: string;
  label: string;
  status: "running" | "done" | "error";
  log: string[];
  progress?: Progress;
  error?: string;
  resultHref?: string;
};

type Props = {
  kind: "search" | "seller" | "sourcing";
  /** kind が seller / sourcing のときに送る固定パラメータ */
  payload?: Record<string, unknown>;
  /** ボタンのラベル */
  buttonLabel: string;
  /** 検索フォーム(kind=search)を出すか */
  withSearchForm?: boolean;
  /** セラーIDの入力欄(kind=seller)を出すか。①を経由せずに深掘りを始めたいとき用 */
  withSellerIdForm?: boolean;
  /** 取得の深さ(標準3件 / 詳細20件)を選ばせるか(kind=seller) */
  withDepthChoice?: boolean;
  /** 探し方(タイトル検索 / 画像検索)を選ばせるか(kind=sourcing) */
  withSourcingOptions?: boolean;
  title: string;
  description?: string;
  compact?: boolean;
};

/** 段階の見出し。順番はそのまま画面の並び順になる */
const PHASE_LABEL: Record<Phase, string> = {
  crawl: "検索結果を読む",
  names: "セラー名を調べる",
  list: "出品を読む",
  ship: "実送料を調べる",
  aggregate: "集計する",
  save: "保存する",
  cluster: "鉄板商品を抽出",
  title: "タイトルで探す",
  image: "画像で探す",
};

/**
 * 画像検索で使う写真の枚数(所要時間の目安を出すためだけに持っている)。
 * 実際に何枚使うかを決めるのはサーバー側 — lib/scraper/sourcing-run.ts の imageCount。
 * あちらの既定値を変えたら、ここも合わせること。
 */
const IMAGE_PHOTOS = 3;

/** キーワード入力の認知用サンプル。原本と同じ「複数・1行1つ」の入れ方を見せる */
const KEYWORD_EXAMPLES: { label: string; keywords: string[]; aruaru: string[] }[] = [
  {
    label: "スマホ周り",
    keywords: ["車載ホルダー", "スマホスタンド"],
    aruaru: ["インポート", "海外輸入"],
  },
  {
    label: "ガジェット一式",
    keywords: [
      "ワイヤレス充電器",
      "充電ケーブル",
      "リングライト",
      "スマホ冷却ファン",
      "ゲームパッド",
      "キーボード",
      "スマホ三脚",
    ],
    aruaru: ["海外"],
  },
  {
    label: "ポーチ×刺繍",
    keywords: ["ポーチ", "化粧ポーチ"],
    aruaru: ["刺繍", "花柄"],
  },
];

const PHASE_ORDER: Record<Props["kind"], Phase[]> = {
  search: ["crawl", "names", "aggregate", "save"],
  seller: ["list", "ship", "save", "cluster"],
  sourcing: ["title", "image", "save"],
};

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}秒`;
  return `${Math.floor(s / 60)}分${String(s % 60).padStart(2, "0")}秒`;
}

export default function ScrapeRunner({
  kind,
  payload,
  buttonLabel,
  withSearchForm,
  withSellerIdForm,
  withDepthChoice,
  withSourcingOptions,
  title,
  description,
  compact,
}: Props) {
  const router = useRouter();
  const [job, setJob] = useState<Job | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ keyword: "", aruaru: "", pages: 2, resolve: 20, sellerId: "" });
  /** 実送料をいくつ取りに行くか。標準3件 / 詳細20件(参考にした既存サービスと同じ刻み) */
  const [depth, setDepth] = useState<3 | 20>(3);
  /** 3-3: どの探し方を使うか。両方外すと実行できない */
  const [modes, setModes] = useState<("title" | "image")[]>(["title", "image"]);
  const [env, setEnv] = useState<{ available: boolean; reason?: string; hint?: string } | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const logRef = useRef<HTMLDivElement>(null);

  const running = job?.status === "running" || starting;

  // 実行中はジョブの状態を取りに行く。
  // 参考にした既存サービスの実測値(約2.8秒)に合わせている。短くしても
  // メルカリへのアクセスが速くなるわけではなく、無駄な通信が増えるだけ。
  useEffect(() => {
    if (!job || job.status !== "running") return;
    const t = setInterval(async () => {
      try {
        const r = await fetch(`/api/scrape?id=${encodeURIComponent(job.id)}`, { cache: "no-store" });
        if (!r.ok) return;
        const next = (await r.json()) as Job;
        setJob(next);
        if (next.status === "done") router.refresh();
      } catch {
        /* ネットワークの一時的な失敗は次の周期で拾う */
      }
    }, 2800);
    return () => clearInterval(t);
  }, [job, router]);

  // 経過時間の表示。実行中だけ1秒ごとに更新する
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [job?.log.length]);

  // この環境でスクレイパーが動くかを最初に確認する。
  // Vercelなどサーバーレスでは動かないので、押せないボタンではなく理由を出す。
  useEffect(() => {
    fetch("/api/scrape", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setEnv(d))
      .catch(() => setEnv({ available: true }));
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setStarting(true);
    setStartedAt(Date.now());
    setNow(Date.now());
    try {
      const body =
        kind === "search"
          ? { kind, keyword: form.keyword, aruaru: form.aruaru, pages: form.pages, resolve: form.resolve }
          : {
              kind,
              ...payload,
              // 入力欄から始めたときは、そこに入っているIDを使う。
              // プロフィールURLを貼られてもよいように、IDの取り出しはサーバー側で行う。
              ...(withSellerIdForm ? { seller_external_id: form.sellerId.trim() } : {}),
              // 実送料の件数は、どちらの入力欄から始めても選んだ値を送る
              ...(withDepthChoice || withSellerIdForm ? { shipping: depth } : {}),
              ...(withSourcingOptions ? { modes } : {}),
            };
      const r = await fetch("/api/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error ?? "起動に失敗しました");
        return;
      }
      setJob({ id: data.jobId, label: "", status: "running", log: [] });
    } catch (e) {
      setError(String(e).slice(0, 200));
    } finally {
      setStarting(false);
    }
  }, [kind, form, payload, depth, withDepthChoice, withSellerIdForm, withSourcingOptions, modes]);

  // 段階の進み具合。全体の何%まで来たかを、段階の順番と段階内の進捗から出す
  // 3-3 は選んだ探し方だけを段階として出す(使わない段階を灰色で残さない)
  const phases = useMemo<Phase[]>(
    () => (withSourcingOptions ? [...modes, "save"] : PHASE_ORDER[kind]),
    [kind, withSourcingOptions, modes]
  );
  const percent = useMemo(() => {
    const p = job?.progress;
    if (!p) return null;
    const idx = phases.indexOf(p.phase);
    if (idx < 0) return null;
    const within = p.total && p.total > 0 ? Math.min(1, (p.done ?? 0) / p.total) : 0;
    return Math.round(((idx + within) / phases.length) * 100);
  }, [job?.progress, phases]);

  /**
   * 実行が終わったか(成功・失敗どちらも)。
   *
   * finishJob() は完了時に progress を undefined にするため、そのままだと
   * percent が null に戻り、「総量不明」用のCSS(width:35% !important)が
   * **完了後に効いてしまう**。インラインの width:100% は !important に負けるので、
   * クラスの側で切り替える必要がある。
   */
  const finished = job?.status === "done" || job?.status === "error";

  const elapsed = startedAt ? fmtElapsed(now - startedAt) : null;
  const canRun = !running && (env === null || env.available);

  return (
    <div className="runner">
      <div className="runner-head">
        <IconSearch size={15} style={{ color: "var(--brand)" }} />
        {title}
      </div>
      {description && (
        <p style={{ margin: "0 0 12px", fontSize: 12.5, color: "var(--text-muted)" }}>{description}</p>
      )}

      {env && !env.available && (
        <div className="note note-info" style={{ marginBottom: 12 }}>
          <IconAlert size={15} />
          <span>
            <strong>この環境では実行できません。</strong>
            {env.reason}
            {env.hint && (
              <>
                <br />
                {env.hint}
              </>
            )}
          </span>
        </div>
      )}

      {withSellerIdForm ? (
        <div className="form-row">
          <label className="field" style={{ flex: 1, minWidth: 260 }}>
            セラーID または プロフィールURL
            <input
              className="input input-wide"
              placeholder="例: 123456789 / https://jp.mercari.com/user/profile/123456789"
              value={form.sellerId}
              disabled={running}
              onChange={(e) => setForm({ ...form, sellerId: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && form.sellerId.trim() && canRun) start();
              }}
            />
          </label>
          <label className="field">
            実送料を調べる件数
            <select
              className="input"
              style={{ width: 168 }}
              value={depth}
              disabled={running}
              onChange={(e) => setDepth(Number(e.target.value) === 20 ? 20 : 3)}
            >
              <option value={3}>標準 — SOLD上位3件</option>
              <option value={20}>詳細 — SOLD上位20件</option>
            </select>
          </label>
          <button
            className="btn btn-primary"
            data-busy={running || undefined}
            onClick={start}
            disabled={!canRun || !form.sellerId.trim()}
            type="button"
          >
            {running ? <IconLoader size={14} className="spin" /> : <IconSearch size={14} />}
            {running ? "実行中" : buttonLabel}
          </button>
        </div>
      ) : withSearchForm ? (
        <div className="search-form">
          <div className="form-row search-keywords-row">
            <label className="field field-keyword">
              <span className="field-label">
                キーワード
                <span className="field-sub">最大10・1行に1つ</span>
              </span>
              <textarea
                className="input input-wide input-keywords"
                rows={4}
                placeholder={"例：\n車載ホルダー\nスマホスタンド"}
                value={form.keyword}
                disabled={running}
                onChange={(e) => setForm({ ...form, keyword: e.target.value })}
              />
            </label>
            <label className="field field-aruaru">
              <span className="field-label">
                あるあるワード
                <span className="field-sub">任意・1行に1つ</span>
              </span>
              <textarea
                className="input input-wide input-keywords"
                rows={4}
                placeholder={"例：\nインポート\n海外輸入"}
                value={form.aruaru}
                disabled={running}
                onChange={(e) => setForm({ ...form, aruaru: e.target.value })}
              />
            </label>
          </div>

          <div className="keyword-examples">
            <span className="hint">入力例（クリックで入れる）</span>
            {KEYWORD_EXAMPLES.map((ex) => (
              <button
                key={ex.label}
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={running}
                title={ex.keywords.join(" / ")}
                onClick={() =>
                  setForm({
                    ...form,
                    keyword: ex.keywords.join("\n"),
                    aruaru: ex.aruaru.join("\n"),
                  })
                }
              >
                {ex.label}
              </button>
            ))}
          </div>

          <div className="form-row">
            <label className="field">
              ページ数
              <input
                className="input"
                type="number"
                min={1}
                max={10}
                style={{ width: 78 }}
                value={form.pages}
                disabled={running}
                onChange={(e) => setForm({ ...form, pages: Number(e.target.value) })}
              />
            </label>
            <label className="field">
              出品者を調べる件数
              <input
                className="input"
                type="number"
                min={1}
                max={120}
                style={{ width: 78 }}
                value={form.resolve}
                disabled={running}
                onChange={(e) => setForm({ ...form, resolve: Number(e.target.value) })}
              />
            </label>
            <button
              className="btn btn-primary"
              data-busy={running || undefined}
              onClick={start}
              disabled={!canRun || !form.keyword.trim()}
              type="button"
            >
              {running ? <IconLoader size={14} className="spin" /> : <IconSearch size={14} />}
              {running ? "実行中" : buttonLabel}
            </button>
          </div>
        </div>
      ) : (
        <div className="form-row">
          {withDepthChoice && (
            <label className="field">
              実送料を調べる件数
              <select
                className="input"
                style={{ width: 168 }}
                value={depth}
                disabled={running}
                onChange={(e) => setDepth(Number(e.target.value) === 20 ? 20 : 3)}
              >
                <option value={3}>標準 — SOLD上位3件</option>
                <option value={20}>詳細 — SOLD上位20件</option>
              </select>
            </label>
          )}
          {withSourcingOptions &&
            (["title", "image"] as const).map((m) => (
              <label className="check" key={m}>
                <input
                  type="checkbox"
                  checked={modes.includes(m)}
                  disabled={running}
                  onChange={(e) =>
                    setModes((cur) =>
                      e.target.checked
                        ? [...new Set([...cur, m])].sort((a, b) => (a === "title" ? -1 : 1))
                        : cur.filter((x) => x !== m)
                    )
                  }
                />
                {PHASE_LABEL[m]}
              </label>
            ))}
          <button
            className={compact ? "btn btn-ghost btn-sm" : "btn btn-primary"}
            data-busy={running || undefined}
            onClick={start}
            disabled={!canRun || (withSourcingOptions && modes.length === 0)}
            type="button"
          >
            {running ? <IconLoader size={14} className="spin" /> : <IconSearch size={14} />}
            {running ? "実行中" : buttonLabel}
          </button>
          {withSourcingOptions && !running && (
            <span className="hint" style={{ alignSelf: "center" }}>
              {modes.length === 0
                ? "探し方を1つ以上選んでください"
                : // 画像検索は「同じ出品の写真を複数枚」使うので、その枚数だけ開く。
                  // 枚数はサーバー側の既定値(lib/scraper/sourcing-run.ts の imageCount)と合わせる。
                  `AliExpressを${modes.reduce((n, m) => n + (m === "image" ? IMAGE_PHOTOS : 1), 0)}回開きます` +
                  `(約${modes.reduce((n, m) => n + (m === "image" ? IMAGE_PHOTOS : 1), 0) * 30}秒)`}
            </span>
          )}
          {withDepthChoice && !running && (
            <span className="hint" style={{ alignSelf: "center" }}>
              1件あたり商品ページを1回開きます(約{depth * 4}秒)
            </span>
          )}
        </div>
      )}

      {error && (
        <div className="note note-error" style={{ marginTop: 12, marginBottom: 0 }}>
          <IconAlert size={15} />
          <span>{error}</span>
        </div>
      )}

      {(job || starting) && (
        <>
          {/* 段階表示: 今どこまで来たか */}
          <div className="phases">
            {phases.map((p, i) => {
              const cur = job?.progress?.phase;
              const curIdx = cur ? phases.indexOf(cur) : -1;
              const state =
                job?.status === "done" ? "done" : curIdx < 0 ? "todo" : i < curIdx ? "done" : i === curIdx ? "active" : "todo";
              return (
                <span key={p} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {i > 0 && <span className="phase-arrow">›</span>}
                  <span className="phase" data-state={state}>
                    {state === "done" ? <IconCheck size={10} /> : <i className="phase-dot" />}
                    {PHASE_LABEL[p]}
                  </span>
                </span>
              );
            })}
          </div>

          {/* 進捗バー: 総量が分かるときは値を、分からないときは往復させる */}
          <div className={!finished && percent === null ? "progress progress-indeterminate" : "progress"}>
            <div
              className="progress-bar"
              data-state={job?.status}
              style={{ width: `${finished ? 100 : (percent ?? 35)}%` }}
            />
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginTop: 6,
              fontSize: 12,
              color: "var(--text-muted)",
              flexWrap: "wrap",
            }}
          >
            {job?.progress?.total ? (
              <span className="num">
                {job.progress.done ?? 0} / {job.progress.total}
              </span>
            ) : null}
            {job?.progress?.label && (
              <span
                className="hint"
                style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "42ch" }}
              >
                {job.progress.label}
              </span>
            )}
            <span className="spacer" style={{ flex: 1 }} />
            {elapsed && <span className="num hint">経過 {elapsed}</span>}
          </div>

          <div className="log" ref={logRef}>
            {!job || job.log.length === 0 ? (
              <span className="log-empty dots">起動しています</span>
            ) : (
              job.log.join("\n")
            )}
          </div>

          <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10, fontSize: 12.5, flexWrap: "wrap" }}>
            {running && (
              <span className="pill pill-brand">
                <IconLoader size={11} className="spin" /> 実行中
              </span>
            )}
            {job?.status === "done" && (
              <span className="pill pill-good flash-ok">
                <IconCheck size={11} /> 完了
              </span>
            )}
            {job?.status === "error" && (
              <span className="pill pill-warn">
                <IconAlert size={11} /> 中断
              </span>
            )}
            {job?.status === "done" && job.resultHref && (
              <Link className="btn btn-primary btn-sm" href={job.resultHref}>
                結果を見る
                <IconArrowRight size={13} />
              </Link>
            )}
            {job && job.status !== "running" && (
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => router.refresh()}>
                <IconRefresh size={12} />
                画面を更新
              </button>
            )}
            <span className="hint">
              {running
                ? "このページを閉じても処理は続きます。メルカリへのアクセスは2.5秒以上の間隔を空けています"
                : "メルカリへのアクセスは2.5秒以上の間隔を空けています"}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
