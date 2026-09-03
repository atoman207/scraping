-- 003: セラーリサーチ(3-1)の精度向上に必要な列を追加
--
-- 背景:
--   従来は検索結果のDOMからしか読めず、商品状態(新品/中古)も更新日時も取れなかった。
--   そのため rank.ts の新品率は null 固定のプレースホルダ、回転日数は sold_at が
--   常に null のため計算不能だった。
--
--   検索結果ページを開いたときにブラウザが受け取るレスポンスには
--   itemConditionId(商品状態) と created/updated(出品日時/最終更新日時)が入っている。
--   これを保存できるようにする。
--
--   ※ 売却日時そのものは公開されていない。updated は「最後に何か動いた時刻」で、
--     売れた商品では概ね取引成立のタイミングになるため、回転日数の推定に使う。
--     推定値であることが分かるよう sold_at とは別の列に入れる。

ALTER TABLE listings
  -- 新品かどうか。メルカリの商品状態マスタ id=1「新品、未使用」のみ true。不明は null
  ADD COLUMN IF NOT EXISTS is_new boolean,
  -- 最終更新日時(ISO)。売却日時ではないが、回転日数の推定に使う
  ADD COLUMN IF NOT EXISTS updated_at text,
  -- メルカリの配送方法マスタのID(名前は変わることがあるのでIDも持つ)
  ADD COLUMN IF NOT EXISTS shipping_method_id text,
  -- メルカリShopsの出品か
  ADD COLUMN IF NOT EXISTS is_shops boolean DEFAULT false,
  -- どの検索でヒットしたか(1商品が複数キーワードで出ることがあるので参考値)
  ADD COLUMN IF NOT EXISTS matched_keyword text;

-- 回転日数の計算に使うので索引を張っておく
CREATE INDEX IF NOT EXISTS listings_seller_status_idx ON listings (seller_id, status);

-- ---- セラー集計結果に、実際に計算できるようになった指標を追加 ----
ALTER TABLE seller_research_results
  -- 何ジャンル(カテゴリ)にまたがっているか。専門特化か複数展開かの判定に使う
  ADD COLUMN IF NOT EXISTS genre_count integer,
  -- セラーの分類(専門特化(穴場候補) / 中堅特化 / 複数展開 / 小規模・単発)
  ADD COLUMN IF NOT EXISTS seller_type text;
