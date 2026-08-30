-- 転売リサーチツール v2 DBスキーマ / Supabase(PostgreSQL)版
-- 元の ../schema.sql (SQLite) と同じテーブル・カラム・制約・デフォルト値を維持している。
-- 変更点は「SQLite固有の書き方をPostgreSQLの同等物に置き換えた」ところだけ:
--   INTEGER PRIMARY KEY AUTOINCREMENT -> bigserial PRIMARY KEY
--   REAL                              -> double precision
--   datetime('now')                   -> to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS')
--                                        (SQLiteのdatetime('now')と同じ "YYYY-MM-DD HH:MM:SS" UTC文字列)
--   INSERT OR IGNORE                  -> INSERT ... ON CONFLICT DO NOTHING
-- 日付系カラムは元と同じく text のまま(取り込み済みデータの互換性を保つため)。

-- ① セラーリサーチの検索履歴
CREATE TABLE IF NOT EXISTS searches (
  id bigserial PRIMARY KEY,
  keywords text NOT NULL,          -- カンマ区切り。最大10件
  aruaru_words text,               -- 「あるあるワード」カンマ区切り(絞り込み用)
  platform text DEFAULT 'mercari', -- 対象プラットフォーム
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
  sold_at text,
  shipping_method text,
  shipping_cost double precision,   -- 実送料(標準=上位3/詳細=上位20件のみ取得)
  image_url text,
  listing_url text,
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
  unit_cost_cny double precision,          -- 仕入単価(元)。未入力ならNULL(送料/原価待ち)
  order_qty integer DEFAULT 1,             -- 発注数(送料の按分に使う)
  source_platform text,                    -- '1688' | 'alibaba' | 'aliexpress'
  source_url text,
  fee_rate_pct double precision DEFAULT 10,-- 販売手数料%(プラットフォーム別に上書き可)
  domestic_shipping_jpy double precision DEFAULT 210,
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
  ng_turnover_days_threshold double precision DEFAULT 14   -- これ超は回転日数NG
);
INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- 深掘りリスト表示用ビュー: 利益計算込み(元のschema.sqlと同一定義)
CREATE OR REPLACE VIEW deepdive_view AS
SELECT
  di.id AS deepdive_id,
  pg.representative_title,
  pg.representative_image_url,
  pg.sold_count,
  pg.avg_price AS mercari_avg_price,
  pg.avg_turnover_days,
  di.unit_cost_cny,
  di.order_qty,
  di.fee_rate_pct,
  di.domestic_shipping_jpy,
  di.source_url,
  s.exchange_rate_jpy_per_cny,
  s.agent_fee_pct,
  s.intl_shipping_cny_per_kg,
  s.box_weight_kg
FROM deepdive_items di
JOIN product_groups pg ON pg.id = di.product_group_id
CROSS JOIN settings s
WHERE s.id = 1;

-- ---- セキュリティ ----
-- このアプリはサーバー側(Server Component / Server Action)から service_role キーで
-- アクセスする。service_role は RLS をバイパスするため、RLSを有効にしておけば
-- anon キー(=ブラウザ側に出る鍵)では一切読み書きできなくなる。
ALTER TABLE searches                ENABLE ROW LEVEL SECURITY;
ALTER TABLE sellers                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller_research_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE listings                ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_groups          ENABLE ROW LEVEL SECURITY;
ALTER TABLE deepdive_items          ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings                ENABLE ROW LEVEL SECURITY;

-- ビューは security_invoker を付けて、下のテーブルのRLSがそのまま効くようにする
-- (PostgreSQL 15以降。Supabaseは15+なので通常成功する)
DO $$
BEGIN
  EXECUTE 'ALTER VIEW deepdive_view SET (security_invoker = on)';
EXCEPTION WHEN OTHERS THEN
  -- 古いPostgreSQLではsecurity_invokerが無いので、代わりに権限を剥奪する
  EXECUTE 'REVOKE ALL ON deepdive_view FROM anon, authenticated';
END $$;
