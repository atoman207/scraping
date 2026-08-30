# 転売リサーチツール — Next.js + Supabase 版

元の構成(Python + SQLite + Next.js)を、**Next.js + Supabase(PostgreSQL)だけ**で動くように
移植したものです。Pythonは不要になりました。

**元のコード(`../engine/`, `../scraper/`, `../webapp/`)は一切変更していません。**
このフォルダは丸ごと新規追加で、元の構成もそのまま並行して動きます。

## 何が変わって、何が変わっていないか

| | 元 | このフォルダ |
|---|---|---|
| 画面(UI) | Next.js 3画面 | **同一**(JSX・スタイル・文言をそのままコピー) |
| 利益計算式 | `webapp/lib/db.ts` / `engine/profit_calc.py` | **同一**(`lib/db.ts` に一字一句そのまま) |
| 鉄板商品の抽出 | `engine/cluster_seller_listings.py` | `lib/engine/cluster.ts`(同一アルゴリズムをTS移植) |
| セラー集計 | `engine/rank_sellers.py` | `lib/engine/rank.ts` |
| CSV取り込み | `scraper/import_csv.py` | `scripts/import-csv.ts` |
| DB | SQLite(`data/tenbai.db`) | **Supabase(PostgreSQL)** |
| Basic認証 | `webapp/middleware.ts` | **同一**(そのままコピー) |
| スクレイパー | 型定義のみ(未実装) | **Playwrightで実装**(3-1/3-2/3-3) |

UIは1文字も変えていないので、画面上の説明文には元のPythonコマンド名
(`engine/rank_sellers.py` など)がそのまま出ます。実際に叩くコマンドは下記の
`npm run engine:*` に置き換わっています。

Pythonの `difflib.SequenceMatcher`(タイトル類似度の計算に使っている)は、
CPythonのアルゴリズムをそのまま `lib/engine/difflib.ts` に移植しています。
同じタイトル群に対してPython版と同じグルーピング結果になります。

## セットアップ

### 0. 必要なもの
- Node.js 18以上(動作確認は v24.17.0)
- Supabaseのアカウント(無料枠でOK) https://supabase.com/

### 1. Supabaseプロジェクトを作る
Supabaseにログイン → New project → リージョンは `Northeast Asia (Tokyo)` あたりを選択。
作成後、**Project Settings > API** で以下2つを控えます。

- `Project URL`(`https://xxxx.supabase.co`)
- `service_role` の `secret` キー(**ブラウザに出してはいけない鍵です**)

### 2. 環境変数を設定する
**`.env.local` は作成済みです**(いただいた URL / secret キーを設定済み)。
新しく作り直す場合は:
```bash
cd tenbai-next
cp .env.example .env.local
```
`.env.local` を開いて `NEXT_PUBLIC_SUPABASE_URL` と `SUPABASE_SERVICE_ROLE_KEY` を
1で控えた値に書き換えます。友人に配る場合は `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` も設定してください
(未設定なら認証なしで動きます。元の webapp と同じ挙動)。

### 3. テーブルを作る
**すでに適用済みです**(いただいたSupabaseプロジェクトに対して確認済み)。
新しいプロジェクトを作り直すときだけ、以下のどちらか一方を実行してください。

**方法A(推奨・手軽)**: Supabaseダッシュボードの **SQL Editor** に
`supabase/schema.sql` の中身を貼り付けて Run。

**方法B(コマンド)**: `.env.local` に `DATABASE_URL`
(Project Settings > Database > Connection string の URI)を設定してから:
```bash
npm install
npm run db:push
```

`schema.sql` は何度実行しても壊れない(冪等)ので、作り直しのときもそのまま流せます。

### 4. 起動する
```bash
npm install
npm run build
npm run start      # 開発中は npm run dev でも可
```
http://localhost:3000

- `/` — ① セラーリサーチ結果(直近の検索の集計値)
- `/seller-deepdive?seller_id=N` — ② 鉄板商品候補。「深掘りリストへ保存」ボタンで③に追加
- `/deepdive-list` — ③ 原価(仕入単価・発注数・仕入先URL)を入力すると自動で黒字判定

### 5. サンプルデータで動作確認する
```bash
npm run import:csv -- --csv data/listings_sample.csv
npm run engine:cluster -- --seller_id 1
```
`/seller-deepdive?seller_id=1` を開くと「ポーチ 刺繍 花柄 小物入れ C /
鉄板候補・再出品3回」が出ます。「深掘りリストへ保存」→ `/deepdive-list` で
仕入単価 `22`・発注数 `50` を入れると、1個利益 `¥924` / 黒字ライン `58.66元` /
月利益 `¥9,239` が表示されます(元のPython版と同じ数字です)。

①のセラーリサーチ画面にデータを出したい場合は、`searches` に1行入れてから:
```bash
npm run engine:rank -- --search_id 1 --keyword "ポーチ" --seller_ids 1
```

## スクレイパー(発注仕様書 3-1 / 3-2 / 3-3)

Playwright(Chromium)で **ログイン不要の公開ページ** を実ブラウザで開き、
レンダリング後のDOMを読む方式で実装しています。非公開の内部APIやトークンには触れていません。

| 仕様書 | 実装 | 状態 |
|---|---|---|
| 3-1 `search_sold` | `MercariScraper.searchSold()` — キーワードのSOLD検索、`page_token` で複数ページ、出品者を商品ページから解決 | 実データで動作確認済み |
| 3-2 `get_seller_listings` | `MercariScraper.getSellerListings()` — セラーページを仮想スクロールしながら最大N件回収 | 実データで動作確認済み |
| 3-2 `get_real_shipping_cost` | `MercariScraper.getRealShippingCost()` — 配送方法名から実送料を特定 | 実装済み(下記の制限あり) |
| 3-3 AliExpress | `AliExpressSourcing.searchCandidates()` — 商品タイトルから候補を検索、元建て価格に換算 | 実データで動作確認済み |
| 3-3 1688 | `Alibaba1688Sourcing` — 検索ディープリンクの生成のみ | ログイン必須のため下記参照 |

### 画面から実行する
①②③の各画面に実行パネルがあり、押すとバックグラウンドで走って進捗ログが流れます。

- ① セラーリサーチ: キーワード/あるあるワード/ページ数/出品者を調べる件数 を入れて「メルカリを検索」
- ② セラー深掘り: 「このセラーの出品を再取得」
- ③ 深掘りリスト: 「AliExpressで仕入れ候補を探す」(最安候補の価格と仕入先URLを自動反映)

### コマンドから実行する
```bash
# 3-1 キーワードでSOLD検索 → セラー特定 → DB投入 → 集計まで
npm run scrape:search -- --keyword "スマホスタンド" --pages 3 --resolve 30
npm run scrape:search -- --keyword "ポーチ" --aruaru 刺繍 花柄 --pages 2

# 3-2 セラーの出品を取得 → 実送料(上位3件) → 鉄板商品抽出まで
npm run scrape:seller -- --seller 223868190 --max 100 --shipping 3

# 3-3 鉄板商品の仕入れ候補を検索(--apply で深掘りリストに反映)
npm run scrape:sourcing -- --group 11 --apply
```

共通オプション: `--interval 6000`(アクセス間隔ms、既定2500)、`--headed`(ブラウザを表示)

### アクセスの作法
- ページ遷移は必ず **2.5秒以上の間隔 + ランダムなゆらぎ** を空け、並列アクセスはしません
- 画像・フォント・広告/計測タグは読み込まずに中断(転送量とサイト側の負荷を下げるため)
- HTTP 403/429/503 やブロックページを検出したら **その場で停止** します(`BlockedError`)。
  自動でリトライして回り込むようなことはしません。止まったら `--interval` を広げて時間をおいてください
- 取得するのは公開されている出品情報だけで、個人情報は取得していません

### 既知の制限(重要)
- **売却日時(`sold_at`)は取得できません。** メルカリの公開ページに売却日時が出ないためです。
  結果として **回転日数が計算できず、画面では「-」表示** になります。
  出品日(`listed_at`)は商品ページの「7時間前」等の相対表記から起こした概算値です。
- **実送料は配送方法名からサイズが一意に決まるときだけ** 取れます
  (ネコポス=210円、宅急便コンパクト=450円、ゆうパケット=230円 など)。
  「らくらくメルカリ便」とだけ書かれている場合や、普通郵便・定形外・取引未完了は
  仕様書どおり取得不可(null)としています。
- **検索結果一覧には出品者が含まれていません。** セラーを確定するには商品ページを個別に開く必要があり、
  1件あたり約3秒かかります。そのため `--resolve`(既定30件)で上限を設けています。
  120件×10ページを全部解決すると6時間以上かかる計算になるので、用途に応じて調整してください。
- **メルカリShops** の商品(IDが `m` + 数字でないもの)は `/shops/product/...` にあり、
  出品者は `shops:<ショップID>` として区別して保存します。
- **1688 は検索ページがログイン必須** で、未ログインだと `login.taobao.com` にリダイレクトされます。
  ログインを突破する実装は入れていないため、検索リンクの生成だけにとどめています。
  自動化したい場合はアカウントを用意して認証済みのブラウザプロファイルを使う必要があります。
- **サイト構造が変われば壊れます。** セレクタは `lib/scraper/mercari.ts` 冒頭のコメントに
  まとめてあるので、壊れたときはそこを見てください。取得0件のときは黙って成功扱いにせずログに出します。
- **Playwrightは常駐サーバーでしか動きません。** Vercel等のサーバーレスにデプロイした場合、
  画面の実行パネル(`/api/scrape`)は使えません。スクレイピングはローカルかVPSで
  CLIを回し、Supabaseを共有する構成にしてください。
- ジョブの進捗ログは **メモリ上のみ** に保持します(サーバー再起動で消えます)。
  取得結果そのものはSupabaseに入るので失われません。

### 利用規約について
メルカリの利用規約は自動化されたアクセスを認めていません。発注仕様書にも
「規約解釈や実施可否の最終判断は発注者側で行う」とある通り、実運用の判断はご自身でお願いします。
技術者としての所見としては、(a) 公開ページのみ・低頻度・個人情報を取らない、という条件でも
規約上のリスクは残る、(b) 継続運用するなら公式のデータ提供元か有料ベンダーの利用が本筋、
という2点をお伝えしておきます。

## 元のPythonコマンドとの対応

| 元 | このフォルダ |
|---|---|
| `python scraper/import_csv.py --db ... --csv X.csv` | `npm run import:csv -- --csv X.csv` |
| `python engine/cluster_seller_listings.py --db ... --seller_id 1` | `npm run engine:cluster -- --seller_id 1` |
| `python engine/rank_sellers.py --db ... --search_id 1 --keyword K --seller_ids 1 2` | `npm run engine:rank -- --search_id 1 --keyword K --seller_ids 1 2` |
| `python engine/profit_calc.py --db ... --out report.csv` | `npm run engine:profit -- --out report.csv` |

`--db` は不要です(接続先は `.env.local` のSupabase設定)。うっかり付けても無視されます。

移植ロジックの自己チェック(DB接続不要):
```bash
npm run test:engine
```

## デプロイ(Vercel)

元のREADMEに書かれていた「SQLiteはサーバーレスで永続化されない」という問題は、
Supabaseにしたことで解消しています。そのままVercelにデプロイできます。

1. このフォルダをGitHubにpush
2. Vercelで Import → Root Directory に `tenbai-next` を指定
3. Environment Variables に `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` /
   `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` を設定
4. Deploy

## セキュリティについて

- DBアクセスは全て**サーバー側**(Server Component / Server Action / CLIスクリプト)からのみ。
  ブラウザにSupabaseの鍵は渡していません。
- 全テーブルで **RLSを有効化**し、ポリシーを1つも作っていません。つまり `anon` キーが
  漏れても読み書きできません。アプリは `service_role` キー(RLSをバイパス)で動きます。
- そのぶん `service_role` キーの管理が重要です。`.env.local` はGitにコミットしないでください
  (`.gitignore` 済み)。
- 画面全体のBasic認証は元の `middleware.ts` のままです。**必ずhttps経由で使ってください。**

## 既知の制限・注意点

- スクレイパーは実装済みです(「スクレイパー」の節を参照)。CSV取り込み(`npm run import:csv`)も併用できます。
- ①セラーリサーチ画面には検索フォームを追加し、スクレイパーに接続済みです。
- `new_item_rate`(新品率)は元のPythonコードと同じくプレースホルダ(NULL)です。
  `listings` に `condition` カラムを足すのが本来の実装です。
- 日付カラムは元のSQLite版と同じ `text` 型のままにしています(`YYYY-MM-DD` 形式)。
  回転日数は SQLite の `julianday()` 差分と同じ計算をTS側で行っています。
- ③深掘りリストの並び順は `deepdive_id` 昇順を明示しています(SQLiteでは登録順で
  返っていたものを、PostgreSQLで同じ見え方にするため)。
- 数値の丸めは元の `webapp/lib/db.ts` と同じ `Math.round`(四捨五入)です。
  Pythonの `round()`(偶数丸め)とは `.5` ちょうどのときだけ差が出ます。

## 動作確認記録

### オフライン
- `npm run test:engine` — difflib移植・クラスタリング・利益計算 全20項目パス
- `supabase/schema.sql` — PostgreSQL 18 に適用・再適用(冪等)を実機確認

### 実際のSupabaseプロジェクトに対して(2026-08-30 実施)
接続先: `https://vzwhndsgqhmjblrnajyd.supabase.co`

| 確認項目 | 結果 |
|---|---|
| `npm run import:csv` | sellers 1件・listings 4件を投入。再実行は `0/4件`(重複無視)で二重登録なし |
| `npm run engine:cluster -- --seller_id 1` | 2グループ生成、鉄板候補1件(再出品3回)。再実行しても2件のまま(upsert動作) |
| `npm run engine:rank -- --search_id 1 ...` | seller_research_results に1件登録 |
| `npm run engine:profit -- --out ...` | BOM付きCSVを出力(1件) |
| ①セラーリサーチ画面 | 「ななまるshop 即購入歓迎 / ★5 (8994) / 4件 / ¥1,853 / 3.8日」を表示 |
| ②セラー深掘り画面 | 「ポーチ 刺繍 花柄 小物入れ C / 鉄板候補・再出品3回 / SOLD 3件 ・ ¥1,977 ・ 3.0日 ・ ¥212」を表示 |
| ②「深掘りリストへ保存」ボタン | deepdive_items に1件INSERTされることを確認 |
| ③「保存/再計算」ボタン | 仕入22元・発注50個を保存 → **黒字ライン 58.66元 / 1個利益 ¥924 / 月利益 ¥9,239**(Python版と同値) |
| ③「原価計算の共通設定」の更新 | 為替21・手数料8%・送料12・箱15に変更 → 65.85元 / ¥994 / ¥9,944 に再計算されることを確認(その後初期値に戻済み) |
| RLS | publishable(anon)キーでは全テーブルが `[]`、INSERTは `42501 row-level security policy` で拒否されることを確認 |

サンプルデータはSupabaseに入ったままです。消す場合はSQL Editorで:
```sql
delete from deepdive_items; delete from product_groups; delete from seller_research_results;
delete from listings; delete from sellers; delete from searches;
```


### スクレイパーの実機確認(2026-08-30 実施・実際のメルカリ/AliExpressに対して)

| 実行 | 結果 |
|---|---|
| 3-1 `npm run scrape:search -- --keyword スマホスタンド --pages 2 --resolve 12` | 2ページで240件のSOLDを回収、出品者9/12件を解決、セラー8人をDB登録、集計まで完走 |
| 3-2 `npm run scrape:seller -- --seller 223868190 --max 40` | 出品30件(SOLD25/販売中5)を取得。クラスタリングで **再出品18回・全SOLDの鉄板商品** を検出 |
| 3-2 実送料 | 「らくらくメルカリ便匿名配送」はサイズ不明のため取得不可と正しく報告。取引未完了の商品はスキップ |
| 3-3 `npm run scrape:sourcing -- --group 2` | AliExpressから6件の候補を取得。最安 6.71元 を深掘りリストに反映 → 1個利益 ¥862 と表示 |
| 画面からの実行 | ②「このセラーの出品を再取得」・③「AliExpressで仕入れ候補を探す」・①検索フォーム のいずれもジョブが起動し、ログが流れて完了することを確認 |
| 日本語の往復 | API経由でジョブラベル・キーワードがUTF-8のまま保持されることを確認 |

実行中に見つけて直した不具合:

- Next.jsがグローバル`fetch`をキャッシュするため、サーバーコンポーネントが古いDB内容を表示していた → Supabaseクライアントに`cache: "no-store"`を指定して修正
- `tsx`が関数に付ける`__name`ラッパがブラウザ側で`ReferenceError`になっていた → ページに空実装を注入して修正
- メルカリShopsの出品者リンク`/shops/profile/<id>`の解析が壊れていた → `shops:`接頭辞を付けて別名前空間として扱うよう修正
- 検索ページの描画待ちが固定sleepで不安定だった → セレクタ待ち+1回のリトライに変更

## ルートの `../schema.sql` について

作業中に、ルートの `../schema.sql` がSQLite版からPostgreSQL版に書き換えられていました
(私の変更ではありません)。**このSupabaseプロジェクトには既にそちらが適用済み**で、
アプリはその状態でそのまま動くように作ってあります(①のJOINはビューではなく
PostgRESTのリソース埋め込みで行っているため、追加のDDLは不要です)。

ただし2点だけ差があります。作り直す機会があれば `supabase/schema.sql` のほうを推奨します。

- **数値の精度**: ルート版は `REAL`(PostgreSQLでは4バイト float)です。SQLiteの `REAL` は
  8バイトなので、元と厳密に同じにするなら `double precision` が正しい対応です
  (`supabase/schema.sql` はそちら)。実害としては平均価格などが有効数字7桁に丸められます
  (例: 1976.6666666666667 → 1976.67)。今回の利益計算では表示結果に差は出ませんでした。
- **日時形式**: ルート版の `NOW()::TEXT` はマイクロ秒+タイムゾーン付き
  (`2026-08-29 16:37:51.976708+00`)になります。SQLiteの `datetime(now)` は
  `YYYY-MM-DD HH:MM:SS` 形式です。`created_at`/`fetched_at` は表示に使っていないので実害はありません。
