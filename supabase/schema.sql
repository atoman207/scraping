-- ============================================================================
--  転売リサーチツール — DBスキーマ（このファイル1本だけ）
--
--  適用:  npm run db:push
--         （DATABASE_URL 未設定なら、このファイルの中身を
--           Supabase ダッシュボード > SQL Editor に貼って Run）
--
--  ■ このファイルの決まりごと
--    ・スキーマの変更は**すべてこのファイルに追記**する。別のマイグレーションファイルは作らない。
--    ・**何度実行しても同じ結果になる**ように書く（冪等）。
--        テーブル : CREATE TABLE IF NOT EXISTS
--        列       : ALTER TABLE ... ADD COLUMN IF NOT EXISTS
--        制約     : DO ブロックで存在を確認してから追加
--        ビュー   : DROP してから CREATE（後述の理由により CREATE OR REPLACE は使わない）
--        関数     : CREATE OR REPLACE
--    ・既存の本番DBに対して流しても、データを消さない。
--
--  ■ ビューを DROP → CREATE している理由
--    PostgreSQL の CREATE OR REPLACE VIEW は、既存の列を「同じ名前・同じ型・同じ順序」で
--    保ったまま**末尾に追加する**ことしかできない。列の順序を変えたり途中に挿したりすると
--    「cannot change name of view column」でエラーになる。
--    このツールではビューの列構成を育てていくので、毎回 DROP してから作り直す。
--    （ビューは実データを持たないので、DROP しても失われるものは無い）
--
--  ■ 日付列が text なのは、元のSQLite版から移行したデータとの互換のため。
-- ============================================================================


-- ============================================================================
--  1. テーブル
-- ============================================================================

-- ① セラーリサーチの検索履歴
CREATE TABLE IF NOT EXISTS searches (
  id bigserial PRIMARY KEY,
  keywords text NOT NULL,          -- カンマ区切り。最大10件
  aruaru_words text,               -- 「あるあるワード」カンマ区切り(絞り込み用)
  platform text DEFAULT 'mercari',
  created_at text DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')
);

-- セラー(メルカリ/ラクマ/ヤフオクの出品者)
CREATE TABLE IF NOT EXISTS sellers (
  id bigserial PRIMARY KEY,
  platform text NOT NULL,
  seller_external_id text NOT NULL,
  seller_name text NOT NULL,
  rating double precision,          -- ★評価
  review_count integer,             -- 評価数
  profile_url text,
  fetched_at text DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (platform, seller_external_id)
);

-- ①の結果: 検索1回につき、ヒットしたセラーごとの集計値
CREATE TABLE IF NOT EXISTS seller_research_results (
  id bigserial PRIMARY KEY,
  search_id bigint NOT NULL REFERENCES searches(id),
  seller_id bigint NOT NULL REFERENCES sellers(id),
  total_sold integer NOT NULL,      -- そのキーワードでの総SOLD件数
  avg_price double precision,
  turnover_days double precision,   -- 平均回転日数(出品〜売却)
  new_item_rate double precision,   -- 新品率(%)
  matched_keyword text,             -- どのキーワード/あるあるワードでヒットしたか
  genre_count integer,              -- 何ジャンルにまたがっているか
  seller_type text,                 -- 専門特化(穴場候補) / 中堅特化 / 複数展開 / 小規模・単発
  UNIQUE (search_id, seller_id, matched_keyword)
);

-- ② セラー深掘りで取得した個別出品(売却済み中心)
CREATE TABLE IF NOT EXISTS listings (
  id bigserial PRIMARY KEY,
  seller_id bigint NOT NULL REFERENCES sellers(id),
  platform text NOT NULL,
  external_id text NOT NULL,
  title text NOT NULL,
  title_normalized text,            -- 正規化後タイトル(グルーピング用)
  price double precision NOT NULL,
  status text NOT NULL,             -- 'active' | 'sold'
  listed_at text,
  sold_at text,                     -- メルカリは非公開のため常にNULL(下の updated_at を使う)
  shipping_method text,
  shipping_cost double precision,   -- 実送料(標準=上位3/詳細=上位20件のみ取得)
  image_url text,
  listing_url text,
  is_new boolean,                   -- 商品状態「新品、未使用」なら true。不明はNULL
  updated_at text,                  -- 最終更新日時。売却日時ではないが回転日数の推定に使う
  shipping_method_id text,          -- メルカリの配送方法マスタID
  is_shops boolean DEFAULT false,   -- メルカリShopsの出品か
  matched_keyword text,             -- どの検索でヒットしたか
  fetched_at text DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (platform, external_id)
);

-- ②の結果: 同一セラー内で同じ商品を繰り返し出品しているグループ = 鉄板商品候補
CREATE TABLE IF NOT EXISTS product_groups (
  id bigserial PRIMARY KEY,
  seller_id bigint NOT NULL REFERENCES sellers(id),
  representative_title text NOT NULL,
  title_normalized text NOT NULL,
  listing_count integer NOT NULL,   -- 同一グループの出品数(再出品含む)
  sold_count integer NOT NULL,
  avg_price double precision,
  avg_turnover_days double precision,
  avg_shipping_cost double precision,
  representative_image_url text,
  is_repeat integer DEFAULT 0,      -- listing_count >= 2 なら1(鉄板商品候補)
  created_at text DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (seller_id, title_normalized)
);

-- ③ 深掘りリスト: ユーザーが保存した商品 + 原価入力 + 黒字判定
CREATE TABLE IF NOT EXISTS deepdive_items (
  id bigserial PRIMARY KEY,
  product_group_id bigint NOT NULL REFERENCES product_groups(id),
  -- 原価の出し方
  cost_mode text DEFAULT 'detail',         -- 'detail'=積み上げ / 'direct'=原価を直接入力
  cost_direct_jpy double precision,        -- cost_mode='direct' のときの原価(円)
  unit_cost_cny double precision,          -- 商品単価(元)。未入力ならNULL
  china_domestic_cny double precision,     -- 中国国内送料(元) 工場→代行倉庫
  tariff_cat text DEFAULT 'other',         -- 関税区分 clothing/plastic/rubber/other
  box_count integer,                       -- 1箱の入数。国際送料の按分に使う
  order_qty integer DEFAULT 1,             -- 発注数(箱入数とは別)
  -- 販売条件
  sell_price_jpy double precision,         -- 売価の上書き。未設定ならグループの平均価格
  shipping_jpy double precision,           -- 送料の上書き。未設定ならグループの実送料
  fee_rate_pct double precision DEFAULT 10,-- 販売手数料%
  packaging_jpy double precision DEFAULT 0,-- 梱包資材費(円/個)
  monthly_qty double precision,            -- 予想月販の手入力(回転日数からの自動計算より優先)
  domestic_shipping_jpy double precision DEFAULT 210,  -- 日本国内の発送料(旧列。互換のため残す)
  -- 仕入先
  source_platform text,                    -- '1688' | 'alibaba' | 'aliexpress'
  source_url text,
  status text DEFAULT 'candidate',         -- 'candidate' | 'adopted' | 'rejected'
  memo text,
  created_at text DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')
);

-- 原価計算の共通設定(アカウント単位。1行のみ)
CREATE TABLE IF NOT EXISTS settings (
  id integer PRIMARY KEY CHECK (id = 1),
  exchange_rate_jpy_per_cny double precision DEFAULT 24,
  agent_fee_pct double precision DEFAULT 5,
  intl_shipping_cny_per_kg double precision DEFAULT 9,
  box_weight_kg double precision DEFAULT 21,
  ng_new_item_rate_threshold double precision DEFAULT 80,  -- これ未満は新品率NG
  ng_turnover_days_threshold double precision DEFAULT 14,  -- これ超は回転日数NG
  import_tax_pct double precision DEFAULT 0                -- 輸入消費税%。0=計上しない
);
INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- スクレイピングのジョブキュー
--   画面    : queued で1行入れるだけ
--   ワーカー: queued を拾って running にし、進捗と結果を書き戻す
--   画面    : その行をポーリングして進捗と結果を出す
CREATE TABLE IF NOT EXISTS jobs (
  id bigserial PRIMARY KEY,
  seq integer,                           -- 画面に出す通し番号(#40 のような表示用)
  kind text NOT NULL,                    -- 'search' | 'seller' | 'sourcing'
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  label text,                            -- 履歴一覧に出す説明文
  status text NOT NULL DEFAULT 'queued', -- 'queued'|'running'|'done'|'error'|'canceled'
  -- 進捗 { phase, i, n, label }
  --   phase: crawl(巡回) / names(セラー名取得) / aggregate(集計) / save(保存)
  --          deep(セラー深掘り) / ship(送料取得)
  progress jsonb,
  log text[] NOT NULL DEFAULT '{}',      -- 実行ログ(直近のみ)
  result jsonb,                          -- 完了時の要約(件数など)
  result_href text,                      -- 完了後に開く画面
  error text,
  locked_by text,                        -- ワーカーが二重に拾わないための排他制御
  locked_at timestamptz,
  heartbeat_at timestamptz,              -- ワーカー生存確認。途絶えたら別のワーカーが拾い直す
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);


-- ============================================================================
--  2. あとから足した列
--
--  CREATE TABLE IF NOT EXISTS は、既にテーブルがある場合は何もしない。
--  そのため「先に古い定義で作られたDB」には上の新しい列が入らない。
--  ここで明示的に足しておくことで、新規のDBでも既存のDBでも同じ形になる。
-- ============================================================================

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS import_tax_pct double precision DEFAULT 0;

ALTER TABLE deepdive_items
  ADD COLUMN IF NOT EXISTS cost_mode text DEFAULT 'detail',
  ADD COLUMN IF NOT EXISTS cost_direct_jpy double precision,
  ADD COLUMN IF NOT EXISTS china_domestic_cny double precision,
  ADD COLUMN IF NOT EXISTS tariff_cat text DEFAULT 'other',
  ADD COLUMN IF NOT EXISTS box_count integer,
  ADD COLUMN IF NOT EXISTS packaging_jpy double precision DEFAULT 0,
  ADD COLUMN IF NOT EXISTS monthly_qty double precision,
  ADD COLUMN IF NOT EXISTS sell_price_jpy double precision,
  ADD COLUMN IF NOT EXISTS shipping_jpy double precision;

ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS is_new boolean,
  ADD COLUMN IF NOT EXISTS updated_at text,
  ADD COLUMN IF NOT EXISTS shipping_method_id text,
  ADD COLUMN IF NOT EXISTS is_shops boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS matched_keyword text;

ALTER TABLE seller_research_results
  ADD COLUMN IF NOT EXISTS genre_count integer,
  ADD COLUMN IF NOT EXISTS seller_type text;

-- 既存行の初期値を埋める(ALTER の DEFAULT は既存行には入らないため)
UPDATE deepdive_items SET cost_mode     = 'detail' WHERE cost_mode IS NULL;
UPDATE deepdive_items SET tariff_cat    = 'other'  WHERE tariff_cat IS NULL;
UPDATE deepdive_items SET packaging_jpy = 0        WHERE packaging_jpy IS NULL;
UPDATE settings       SET import_tax_pct = 0       WHERE import_tax_pct IS NULL;


-- ============================================================================
--  3. 制約
--
--  ALTER TABLE ... ADD CONSTRAINT には IF NOT EXISTS が無く、2回目でエラーになる。
--  存在を確認してから足す。
--  NOT VALID を付けているのは、既存行の検査を省いて即座に適用するため
--  (以後の INSERT/UPDATE には効く)。
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deepdive_items_cost_mode_chk') THEN
    ALTER TABLE deepdive_items
      ADD CONSTRAINT deepdive_items_cost_mode_chk
      CHECK (cost_mode IN ('detail', 'direct')) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deepdive_items_tariff_chk') THEN
    ALTER TABLE deepdive_items
      ADD CONSTRAINT deepdive_items_tariff_chk
      CHECK (tariff_cat IN ('clothing', 'plastic', 'rubber', 'other')) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_status_chk') THEN
    ALTER TABLE jobs
      ADD CONSTRAINT jobs_status_chk
      CHECK (status IN ('queued', 'running', 'done', 'error', 'canceled')) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_kind_chk') THEN
    ALTER TABLE jobs
      ADD CONSTRAINT jobs_kind_chk
      CHECK (kind IN ('search', 'seller', 'sourcing')) NOT VALID;
  END IF;
END $$;


-- ============================================================================
--  4. 索引
-- ============================================================================

CREATE INDEX IF NOT EXISTS listings_seller_status_idx ON listings (seller_id, status);
CREATE INDEX IF NOT EXISTS jobs_status_created_idx    ON jobs (status, created_at);
CREATE INDEX IF NOT EXISTS jobs_created_idx           ON jobs (created_at DESC);


-- ============================================================================
--  5. ビュー
--
--  深掘りリスト表示用。計算そのものは lib/engine/cost.ts で行うので、
--  ビューは「計算に必要な素材を1行に揃える」だけに徹する。
--  (SQLとTypeScriptに計算式が二重にあると、画面とCLIで数字がズレる原因になる)
--
--  列構成を変えられるよう、CREATE OR REPLACE ではなく DROP → CREATE にしている。
-- ============================================================================

DROP VIEW IF EXISTS deepdive_view;
CREATE VIEW deepdive_view AS
SELECT
  di.id AS deepdive_id,
  di.product_group_id,
  pg.representative_title,
  pg.representative_image_url,
  pg.sold_count,
  pg.listing_count,
  pg.avg_price AS mercari_avg_price,
  pg.avg_turnover_days,
  pg.avg_shipping_cost,
  -- 原価の入力値
  di.cost_mode,
  di.cost_direct_jpy,
  di.unit_cost_cny,            -- 商品単価(元)
  di.china_domestic_cny,       -- 中国国内送料(元)
  di.tariff_cat,
  di.box_count,
  di.order_qty,
  -- 販売条件(上書きが無ければグループの実測値を使う)
  COALESCE(di.sell_price_jpy, pg.avg_price)       AS sell_price_jpy,
  COALESCE(di.shipping_jpy, pg.avg_shipping_cost) AS shipping_jpy,
  di.fee_rate_pct,
  di.packaging_jpy,
  di.monthly_qty,
  di.domestic_shipping_jpy,
  di.source_platform,
  di.source_url,
  di.status,
  di.memo,
  di.created_at,
  -- 共通設定
  s.exchange_rate_jpy_per_cny,
  s.agent_fee_pct,
  s.intl_shipping_cny_per_kg,
  s.box_weight_kg,
  s.import_tax_pct
FROM deepdive_items di
JOIN product_groups pg ON pg.id = di.product_group_id
CROSS JOIN settings s
WHERE s.id = 1;


-- ============================================================================
--  6. 関数・トリガ(ジョブキュー)
-- ============================================================================

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
 * FOR UPDATE SKIP LOCKED で1行だけロックして取る。
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
  SET status       = 'running',
      locked_by    = worker_id,
      locked_at    = now(),
      heartbeat_at = now(),
      started_at   = COALESCE(started_at, now()),
      attempts     = attempts + 1
  WHERE id = target
  RETURNING *;
END;
$$ LANGUAGE plpgsql;

/** 自分の前に何件待っているかを返す(画面の「あなたの前に◯件」用) */
CREATE OR REPLACE FUNCTION queue_ahead(job_id bigint)
RETURNS integer AS $$
  SELECT COUNT(*)::integer
  FROM jobs j
  WHERE j.status IN ('queued', 'running')
    AND j.created_at < (SELECT created_at FROM jobs WHERE id = job_id);
$$ LANGUAGE sql STABLE;


-- ============================================================================
--  7. セキュリティ
--
--  このアプリはサーバー側から service_role キーでアクセスする。
--  service_role は RLS をバイパスするため、RLSを有効にしておけば
--  anon キー(=ブラウザ側に出る鍵)では一切読み書きできなくなる。
-- ============================================================================

ALTER TABLE searches                ENABLE ROW LEVEL SECURITY;
ALTER TABLE sellers                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller_research_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE listings                ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_groups          ENABLE ROW LEVEL SECURITY;
ALTER TABLE deepdive_items          ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings                ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs                    ENABLE ROW LEVEL SECURITY;

-- ビューは security_invoker を付けて、下のテーブルのRLSがそのまま効くようにする
-- (PostgreSQL 15以降。Supabaseは15+なので通常成功する)
DO $$
BEGIN
  EXECUTE 'ALTER VIEW deepdive_view SET (security_invoker = on)';
EXCEPTION WHEN OTHERS THEN
  -- 古いPostgreSQLでは security_invoker が無いので、代わりに権限を剥奪する
  EXECUTE 'REVOKE ALL ON deepdive_view FROM anon, authenticated';
END $$;
