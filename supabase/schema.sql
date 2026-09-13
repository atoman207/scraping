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
  avatar_url text,                  -- プロフィール画像。既定画像のセラーはNULL(画面で頭文字を出す)
  listing_count integer,            -- メルカリ側の総出品数(販売中)
  good_ratings integer,             -- 良い評価の件数
  bad_ratings integer,              -- 悪い評価の件数
  registered_at text,               -- 出品者としての登録日
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
  -- 実送料の取得状況。「取れなかった」と「そもそも対象外」を区別する(3-2)
  --   got    : 発送時に確定した実送料を取得できた
  --   fixed  : 全国一律料金なので金額が確定している(クリックポスト・着払い)
  --   failed : 取りに行ったが金額が公開されていなかった   → 画面は「(送料待ち)」
  --   na     : 普通郵便・定形外・未定・取引未完了・Shops  → 画面は「—」
  --   skip   : そのモードでは取得対象にしていない        → 画面は「—」
  ship_status text,
  ship_class text,                  -- 発送時に確定したサイズ区分名(「ネコポス」など)
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
  -- ここから下は「どれくらい売れ続けているか」を画面で判断するための列
  stock_count integer,              -- 販売中の件数(まだ在庫がある = 今も売っている)
  min_price double precision,       -- 価格レンジ。値下げ幅が大きい商品は利益がぶれる
  max_price double precision,
  first_listed_at text,             -- 最初に出品した日。長く回しているほど鉄板度が高い
  latest_sold_at text,              -- 直近で売れた日。古いものは今は売れていない可能性
  sold_per_month double precision,  -- 実測の月販数(観測期間から算出。回転日数からの推定より確か)
  shipping_method text,             -- 代表的な発送方法
  ship_status text,                 -- 実送料の取得状況(got/fixed/failed/na/skip)
  ship_class text,                  -- 発送時に確定したサイズ区分名
  representative_listing_url text,  -- 代表商品のメルカリURL
  distinct_title_count integer,     -- 束ねたタイトルの種類数。多い=タイトルを変えて出し直している
  merged_titles jsonb,              -- 束ねた実際のタイトル一覧(グルーピングの妥当性を目で確認できる)
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

-- ④ 3-3: AliExpress / 1688 から拾った仕入れ候補
--
--   product_groups(鉄板商品)ごとに、タイトル検索と画像検索で見つけた候補を貯める。
--   同じ商品を検索し直したら、その商品ぶんを入れ替える(履歴は残さない)。
--   1688 はログインが必要で商品そのものを取れないため、
--   search_mode='link' の「検索URLだけの行」が入る。
CREATE TABLE IF NOT EXISTS sourcing_candidates (
  id bigserial PRIMARY KEY,
  product_group_id bigint NOT NULL REFERENCES product_groups(id) ON DELETE CASCADE,
  source_platform text NOT NULL,        -- 'aliexpress' | '1688'
  search_mode text NOT NULL,            -- 'title'=タイトル検索 / 'image'=画像検索 / 'link'=検索URLのみ
  query text,                           -- 実際に投げた検索語、または画像検索の結果URL
  external_id text,                     -- サイト側の商品ID(AliExpressの数字ID)
  title text NOT NULL,
  price double precision,               -- 表示通貨のままの価格
  currency text,                        -- 'JPY' | 'USD' | 'CNY'
  price_jpy double precision,
  price_cny double precision,           -- deepdive_items.unit_cost_cny にそのまま入れられる
  url text NOT NULL,
  image_url text,
  min_order_qty integer,
  orders_count integer,                 -- 「1,000+ 点販売」の数字
  rating double precision,
  is_ad boolean DEFAULT false,          -- 広告枠(検索順位ではなく出稿で上に出ている)
  match_score double precision,         -- 元タイトルとの一致度 0-100
  rank integer,                         -- 画面に出す並び順(1が最有力)
  is_picked boolean DEFAULT false,      -- 深掘りリストに採用した候補
  fetched_at text DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (product_group_id, source_platform, search_mode, url)
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

-- ⑧ ログイン用の利用者
--
--   利用者が自分で登録することはできない。管理者が /admin で発行する。
--   パスワードは scrypt ハッシュ(ログイン検証用)と、管理者確認用の暗号文を保存する
--   (書式は lib/auth.ts の hashPassword() / encryptPassword() を参照)。
CREATE TABLE IF NOT EXISTS app_users (
  id bigserial PRIMARY KEY,
  username text NOT NULL,
  password_hash text NOT NULL,
  password_enc text,                     -- 管理者確認用(AES-GCM)。無い古い行は表示不可
  role text NOT NULL DEFAULT 'member',   -- 'admin' | 'member'
  display_name text,
  note text,                             -- 誰に渡したかのメモ
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  UNIQUE (username)
);

-- ログインセッション。ブラウザのCookieにはこの token だけを入れる
CREATE TABLE IF NOT EXISTS app_sessions (
  token text PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  user_agent text
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
  ADD COLUMN IF NOT EXISTS matched_keyword text,
  ADD COLUMN IF NOT EXISTS ship_status text,
  ADD COLUMN IF NOT EXISTS ship_class text;

ALTER TABLE seller_research_results
  ADD COLUMN IF NOT EXISTS genre_count integer,
  ADD COLUMN IF NOT EXISTS seller_type text;

ALTER TABLE sellers
  ADD COLUMN IF NOT EXISTS avatar_url text,
  ADD COLUMN IF NOT EXISTS listing_count integer,
  ADD COLUMN IF NOT EXISTS good_ratings integer,
  ADD COLUMN IF NOT EXISTS bad_ratings integer,
  ADD COLUMN IF NOT EXISTS registered_at text;

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS password_enc text;

-- 1688 の候補から取れる追加情報。
--   1688Japan(公式総代理店)経由で取ると、AliExpress には無い
--   「店の信用度」まで分かるので、そこを取りこぼさない。
ALTER TABLE sourcing_candidates
  -- 回头率(リピート率 %)。「その店で買った人がまた買っている割合」で、
  -- 1688 の店の良し悪しを見るときにいちばん効く指標
  ADD COLUMN IF NOT EXISTS repeat_rate double precision,
  -- 店舗バッジ(実力商家・厳選工場・誠信通・1688厳選)。文字列の配列
  ADD COLUMN IF NOT EXISTS badges jsonb,
  -- 何枚の写真から見つかったか。複数枚から出た商品ほど確からしい
  ADD COLUMN IF NOT EXISTS photo_hits integer,
  -- 1688 に出品された日。長く売られている商品ほど定番である目安になる
  ADD COLUMN IF NOT EXISTS listed_at text;

ALTER TABLE product_groups
  ADD COLUMN IF NOT EXISTS stock_count integer,
  ADD COLUMN IF NOT EXISTS min_price double precision,
  ADD COLUMN IF NOT EXISTS max_price double precision,
  ADD COLUMN IF NOT EXISTS first_listed_at text,
  ADD COLUMN IF NOT EXISTS latest_sold_at text,
  ADD COLUMN IF NOT EXISTS sold_per_month double precision,
  ADD COLUMN IF NOT EXISTS shipping_method text,
  ADD COLUMN IF NOT EXISTS ship_status text,
  ADD COLUMN IF NOT EXISTS ship_class text,
  ADD COLUMN IF NOT EXISTS representative_listing_url text,
  ADD COLUMN IF NOT EXISTS distinct_title_count integer,
  ADD COLUMN IF NOT EXISTS merged_titles jsonb;

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
CREATE INDEX IF NOT EXISTS app_sessions_user_idx      ON app_sessions (user_id);
CREATE INDEX IF NOT EXISTS app_sessions_expires_idx   ON app_sessions (expires_at);
CREATE INDEX IF NOT EXISTS sourcing_group_rank_idx     ON sourcing_candidates (product_group_id, rank);


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
  pg.representative_listing_url,   -- サムネイル/タイトルのリンク先(メルカリ商品ページ)
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
ALTER TABLE sourcing_candidates     ENABLE ROW LEVEL SECURITY;
-- 利用者とセッションは、anonキーからは絶対に読めてはいけない
ALTER TABLE app_users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_sessions            ENABLE ROW LEVEL SECURITY;

-- ビューは security_invoker を付けて、下のテーブルのRLSがそのまま効くようにする
-- (PostgreSQL 15以降。Supabaseは15+なので通常成功する)
DO $$
BEGIN
  EXECUTE 'ALTER VIEW deepdive_view SET (security_invoker = on)';
EXCEPTION WHEN OTHERS THEN
  -- 古いPostgreSQLでは security_invoker が無いので、代わりに権限を剥奪する
  EXECUTE 'REVOKE ALL ON deepdive_view FROM anon, authenticated';
END $$;
