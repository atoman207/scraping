/**
 * 画面からスクレイパーを起動するための、プロセス内ジョブ管理。
 *
 * スクレイピングは数十秒〜数分かかるので、リクエストの中で待たせずに
 * バックグラウンドで走らせ、画面はポーリングで進捗ログを見る。
 *
 * 状態はメモリ上にしか持たない(= サーバーを再起動すると履歴は消える)。
 * DBにテーブルを足さずに済ませるための割り切りで、実行結果そのものは
 * sellers / listings / product_groups に入るので失われない。
 */

export type JobStatus = "running" | "done" | "error";

/**
 * 実行中のどの段階にいるか。
 *
 * 画面はこれを見て進捗バーと段階表示を描く。ログの文字列から推測すると
 * ログの言い回しを変えるたびに画面が壊れるので、構造化して持つ。
 */
export type JobPhase =
  /** 検索結果ページを読んでいる(3-1) */
  | "crawl"
  /** セラー名を1人ずつ解決している(3-1) */
  | "names"
  /** セラーの出品一覧を読んでいる(3-2) */
  | "list"
  /** 実送料を商品ページから取っている(3-2) */
  | "ship"
  /** 集計している */
  | "aggregate"
  /** DBへ書いている */
  | "save"
  /** 鉄板商品を抽出している(3-2) */
  | "cluster"
  /** タイトルで仕入れ候補を探している(3-3) */
  | "title"
  /** 画像で仕入れ候補を探している(3-3) */
  | "image";

export type JobProgress = {
  phase: JobPhase;
  /** 済んだ数 / 全体。全体が分からない段階では total を省く */
  done?: number;
  total?: number;
  /** 「3/10ページ目」のような補足 */
  label?: string;
};

export type Job = {
  id: string;
  kind: "search" | "seller" | "sourcing";
  label: string;
  status: JobStatus;
  log: string[];
  progress?: JobProgress;
  error?: string;
  /** 完了後、画面がここへ遷移すると結果が見られる */
  resultHref?: string;
  startedAt: number;
  finishedAt?: number;
};

// Next.jsのdev環境ではモジュールが再評価されることがあるのでglobalに載せる
const store: Map<string, Job> =
  (globalThis as { __tenbaiJobs?: Map<string, Job> }).__tenbaiJobs ??
  ((globalThis as { __tenbaiJobs?: Map<string, Job> }).__tenbaiJobs = new Map());

export function createJob(kind: Job["kind"], label: string): Job {
  const job: Job = {
    id: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind,
    label,
    status: "running",
    log: [],
    startedAt: Date.now(),
  };
  store.set(job.id, job);
  // 古いジョブを掃除(最新20件だけ残す)
  if (store.size > 20) {
    const oldest = [...store.values()].sort((a, b) => a.startedAt - b.startedAt).slice(0, store.size - 20);
    for (const o of oldest) store.delete(o.id);
  }
  return job;
}

export function getJob(id: string): Job | undefined {
  return store.get(id);
}

export function appendLog(id: string, line: string): void {
  const job = store.get(id);
  if (!job) return;
  job.log.push(line);
  if (job.log.length > 400) job.log.splice(0, job.log.length - 400);
}

/** 現在の段階を更新する。画面の進捗バーと段階表示がこれを見る */
export function setProgress(id: string, progress: JobProgress): void {
  const job = store.get(id);
  if (!job) return;
  job.progress = progress;
}

export function finishJob(id: string, patch: Partial<Pick<Job, "status" | "error" | "resultHref">>): void {
  const job = store.get(id);
  if (!job) return;
  Object.assign(job, patch, { finishedAt: Date.now(), progress: undefined });
}

/** 直近のジョブ(画面の初期表示用) */
export function latestJob(kind?: Job["kind"]): Job | undefined {
  return [...store.values()]
    .filter((j) => !kind || j.kind === kind)
    .sort((a, b) => b.startedAt - a.startedAt)[0];
}
