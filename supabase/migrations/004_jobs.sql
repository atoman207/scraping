-- 004: スクレイピングジョブの永続化
--
-- 背景:
--   lib/jobs.ts はジョブをメモリ上のMapにしか持っておらず、
--     - サーバーを再起動すると実行中のジョブも履歴も消える
--     - Vercel のようなサーバーレスでは、リクエストごとに別インスタンスになるため
--       「起動したジョブの進捗を次のリクエストで見る」ことができない
--   という制約があった。
--
--   Vercel(画面) と ワーカー(スクレイピング) を別々の場所で動かすため、
--   ジョブの受け渡しをDB経由にする。
--     画面  : jobs に queued で1行入れるだけ
--     ワーカー: queued を拾って running にし、進捗と結果を書き戻す
--     画面  : その行をポーリングして進捗と結果を出す

CREATE TABLE IF NOT EXISTS jobs (
  id bigserial PRIMARY KEY,
  -- 画面に出す通し番号(#40 のような表示用)。将来ユーザーごとに振り直せるよう分けてある
  seq integer,
  kind text NOT NULL,                    -- 'search' | 'seller' | 'sourcing'
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  label text,                            -- 履歴一覧に出す説明文
  status text NOT NULL DEFAULT 'queued', -- 'queued' | 'running' | 'done' | 'error' | 'canceled'
  -- 進捗。{ phase, i, n, label } を入れる
  --   phase: 'crawl'(巡回) | 'names'(セラー名取得) | 'aggregate'(集計) | 'save'(保存)
  --          'deep'(セラー深掘り) | 'ship'(送料取得)
  progress jsonb,
  log text[] NOT NULL DEFAULT '{}',      -- 実行ログ(直近のみ)
  result jsonb,                          -- 完了時の要約(件数など)
  result_href text,                      -- 完了後に開く画面
  error text,
  -- ワーカーが二重に拾わないための排他制御
  locked_by text,
  locked_at timestamptz,
  heartbeat_at timestamptz,              -- ワーカー生存確認。古いものは復旧対象
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS jobs_status_created_idx ON jobs (status, created_at);
CREATE INDEX IF NOT EXISTS jobs_created_idx ON jobs (created_at DESC);

-- 通し番号を自動で振る
CREATE OR REPLACE FUNCTION jobs_set_seq() RETURNS trigger AS $$
BEGIN
  IF NEW.seq IS NULL THEN
    SELECT COALESCE(MAX(seq), 0) + 1 INTO NEW.seq FROM jobs;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jobs_seq_trigger ON jobs;
CREATE TRIGGER jobs_seq_trigger BEFORE INSERT ON jobs
  FOR EACH ROW EXECUTE FUNCTION jobs_set_seq();

/**
 * 待っているジョブを1件だけ取り出して running にする。
 *
 * 複数のワーカーを同時に動かしても同じジョブを二重に処理しないよう、
 * FOR UPDATE SKIP LOCKED で1行をロックして取る。
 *
 * heartbeat が5分以上途絶えた running は、ワーカーが落ちたとみなして拾い直す。
 */
CREATE OR REPLACE FUNCTION claim_job(worker_id text)
RETURNS SETOF jobs AS $$
DECLARE
  target bigint;
BEGIN
  SELECT id INTO target
  FROM jobs
  WHERE status = 'queued'
     OR (status = 'running' AND heartbeat_at < now() - interval '5 minutes')
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF target IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE jobs
  SET status = 'running',
      locked_by = worker_id,
      locked_at = now(),
      heartbeat_at = now(),
      started_at = COALESCE(started_at, now()),
      attempts = attempts + 1
  WHERE id = target
  RETURNING *;
END;
$$ LANGUAGE plpgsql;

/** 自分の順番待ちが何件目かを返す(画面の「あなたの前に◯件」用) */
CREATE OR REPLACE FUNCTION queue_ahead(job_id bigint)
RETURNS integer AS $$
  SELECT COUNT(*)::integer
  FROM jobs j
  WHERE j.status IN ('queued', 'running')
    AND j.created_at < (SELECT created_at FROM jobs WHERE id = job_id);
$$ LANGUAGE sql STABLE;

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
