-- 002: 原価モデルの拡張（Seller Scope 調査の反映）
--
-- 既存の supabase/schema.sql は触らず、足りなかった列だけを追加する追記型のマイグレーション。
-- 何度実行しても壊れない（IF NOT EXISTS / OR REPLACE）。
--
-- 追加の理由は tenbai-next/SELLERSCOPE_ANALYSIS.md の「6. 実装する際の要点」を参照。
--   1. 中国国内送料が原価に入っていなかった
--   2. 関税が入っていなかった（品目で 0〜10% 違う）
--   3. 梱包費が利益から引かれていなかった
--   4. 「箱入数」と「発注数」が order_qty 1本で兼用されていた（別物）
--   5. 予想月販の手入力ができなかった
--   6. 原価を直接入力するモードが無かった

-- ---- 共通設定 ----
ALTER TABLE settings
  -- 輸入消費税 %。既定0 = Seller Scope 互換（彼らは計上していない）。
  -- 実際に納めているなら 10 を入れると原価に載る。
  ADD COLUMN IF NOT EXISTS import_tax_pct double precision DEFAULT 0;

-- ---- 深掘りリストの1商品 ----
ALTER TABLE deepdive_items
  -- 'detail' = 単価・送料・関税から積み上げ / 'direct' = 原価(円)を直接入力
  ADD COLUMN IF NOT EXISTS cost_mode text DEFAULT 'detail',
  ADD COLUMN IF NOT EXISTS cost_direct_jpy double precision,
  -- 中国国内送料(元)。工場→代行倉庫。既存の domestic_shipping_jpy(日本国内の発送料)とは別物
  ADD COLUMN IF NOT EXISTS china_domestic_cny double precision,
  -- 関税区分: clothing(10%) / plastic(3%) / rubber(0%) / other(5%)
  ADD COLUMN IF NOT EXISTS tariff_cat text DEFAULT 'other',
  -- 1箱に何個入るか。国際送料の按分に使う。発注数(order_qty)とは別
  ADD COLUMN IF NOT EXISTS box_count integer,
  -- 梱包資材費(円/個)
  ADD COLUMN IF NOT EXISTS packaging_jpy double precision DEFAULT 0,
  -- 予想月販数の手入力。入っていれば回転日数からの自動計算より優先
  ADD COLUMN IF NOT EXISTS monthly_qty double precision,
  -- 売価・送料の上書き。未設定ならグループの平均価格・実送料を使う
  ADD COLUMN IF NOT EXISTS sell_price_jpy double precision,
  ADD COLUMN IF NOT EXISTS shipping_jpy double precision;

ALTER TABLE deepdive_items
  ADD CONSTRAINT deepdive_items_cost_mode_chk CHECK (cost_mode IN ('detail', 'direct')) NOT VALID;

ALTER TABLE deepdive_items
  ADD CONSTRAINT deepdive_items_tariff_chk CHECK (tariff_cat IN ('clothing', 'plastic', 'rubber', 'other')) NOT VALID;

-- 既存行の初期値を埋める（ALTER の DEFAULT は既存行に入らないため）
UPDATE deepdive_items SET cost_mode   = 'detail' WHERE cost_mode IS NULL;
UPDATE deepdive_items SET tariff_cat  = 'other'  WHERE tariff_cat IS NULL;
UPDATE deepdive_items SET packaging_jpy = 0      WHERE packaging_jpy IS NULL;
UPDATE settings       SET import_tax_pct = 0     WHERE import_tax_pct IS NULL;

-- ---- 表示用ビューを作り直す ----
-- 計算そのものは lib/engine/cost.ts で行うので、ビューは「素材を1行に揃える」だけに徹する。
-- （SQLに計算式を二重に持つと、画面とCLIで数字がズレる原因になる）
CREATE OR REPLACE VIEW deepdive_view AS
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
  -- 販売条件
  COALESCE(di.sell_price_jpy, pg.avg_price)        AS sell_price_jpy,
  COALESCE(di.shipping_jpy, pg.avg_shipping_cost)  AS shipping_jpy,
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

DO $$
BEGIN
  EXECUTE 'ALTER VIEW deepdive_view SET (security_invoker = on)';
EXCEPTION WHEN OTHERS THEN
  EXECUTE 'REVOKE ALL ON deepdive_view FROM anon, authenticated';
END $$;
