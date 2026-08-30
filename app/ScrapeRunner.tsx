"use client";

/**
 * スクレイパーを画面から起動し、進捗ログをポーリングして表示するパネル。
 * 実行そのものは /api/scrape がサーバー側で行う。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { IconAlert, IconCheck, IconLoader, IconSearch } from "./icons";

type Job = {
  id: string;
  label: string;
  status: "running" | "done" | "error";
  log: string[];
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
  title: string;
  description?: string;
  compact?: boolean;
};

export default function ScrapeRunner({
  kind,
  payload,
  buttonLabel,
  withSearchForm,
  title,
  description,
  compact,
}: Props) {
  const router = useRouter();
  const [job, setJob] = useState<Job | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ keyword: "", aruaru: "", pages: 2, resolve: 20 });
  const [env, setEnv] = useState<{ available: boolean; reason?: string; hint?: string } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const running = job?.status === "running" || starting;

  // 実行中はジョブの状態を2秒おきに取りに行く
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
    }, 2000);
    return () => clearInterval(t);
  }, [job, router]);

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
    try {
      const body =
        kind === "search"
          ? { kind, keyword: form.keyword, aruaru: form.aruaru, pages: form.pages, resolve: form.resolve }
          : { kind, ...payload };
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
  }, [kind, form, payload]);

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

      {withSearchForm ? (
        <div className="form-row">
          <label className="field" style={{ flex: 1, minWidth: 220 }}>
            キーワード
            <input
              className="input input-wide"
              placeholder="例: スマホスタンド"
              value={form.keyword}
              disabled={running}
              onChange={(e) => setForm({ ...form, keyword: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && form.keyword.trim() && !running) start();
              }}
            />
          </label>
          <label className="field" style={{ flex: 1, minWidth: 180 }}>
            あるあるワード(任意・スペース区切り)
            <input
              className="input input-wide"
              placeholder="例: 折りたたみ 木製"
              value={form.aruaru}
              disabled={running}
              onChange={(e) => setForm({ ...form, aruaru: e.target.value })}
            />
          </label>
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
            onClick={start}
            disabled={running || !form.keyword.trim() || env !== null && !env.available}
            type="button"
          >
            {running ? <IconLoader size={14} className="spin" /> : <IconSearch size={14} />}
            {running ? "実行中…" : buttonLabel}
          </button>
        </div>
      ) : (
        <button
          className={compact ? "btn btn-ghost btn-sm" : "btn btn-primary"}
          onClick={start}
          disabled={running || env !== null && !env.available}
          type="button"
        >
          {running ? <IconLoader size={14} className="spin" /> : <IconSearch size={14} />}
          {running ? "実行中…" : buttonLabel}
        </button>
      )}

      {error && (
        <div className="note note-error" style={{ marginTop: 12, marginBottom: 0 }}>
          <IconAlert size={15} />
          <span>{error}</span>
        </div>
      )}

      {job && (
        <>
          <div className="log" ref={logRef}>
            {job.log.length === 0 ? (
              <span className="log-empty">起動しています…</span>
            ) : (
              job.log.join("\n")
            )}
          </div>
          <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10, fontSize: 12.5 }}>
            {job.status === "running" && (
              <span className="badge badge-brand">
                <IconLoader size={11} className="spin" /> 実行中
              </span>
            )}
            {job.status === "done" && (
              <span className="badge badge-green">
                <IconCheck size={11} /> 完了
              </span>
            )}
            {job.status === "error" && (
              <span className="badge badge-red">
                <IconAlert size={11} /> 中断
              </span>
            )}
            {job.status !== "running" && (
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => router.refresh()}>
                画面を更新
              </button>
            )}
            <span style={{ color: "var(--text-faint)" }}>
              メルカリへのアクセスは2.5秒以上の間隔を空けています
            </span>
          </div>
        </>
      )}
    </div>
  );
}
