# 3-1 セラーリサーチ — 動作確認の手順

発注仕様書 3-1（`SellerResearchAdapter.search_sold`）が仕様どおり動くことを確認する手順です。
**上から順に実行すれば、DBを汚さずに確認 →  実データ投入 → 画面表示 まで進めます。**

---

## 事前準備（1回だけ）

```bash
cd tenbai-next

# 1. ブラウザ本体を入れる
npx playwright install chromium

# 2. DBスキーマを適用する
npm run db:push
#    DATABASE_URL 未設定なら supabase/schema.sql を Supabase の SQL Editor に貼って Run

# 3. 適用できたか確認（ここが OK にならないと保存で失敗します）
npm run db:check
```

期待する出力：
```
  OK  settings                   1列を確認
  OK  deepdive_items             9列を確認
  OK  listings                   5列を確認
  OK  seller_research_results    2列を確認
  OK  jobs                       8列を確認
  OK  deepdive_view              作り直し済み
  OK  claim_job()                呼び出せました

  OK 7件 / NG 0件
  すべて適用済みです。
```

---

## テスト1: ネットにつながずロジックだけ確認（数秒）

集計・分類・NG判定・計算式が正しいかを、作り物のデータで確かめます。

```bash
npm run test:aggregate    # セラー集計（25件）
npm run test:cost         # 原価・利益計算（27件）
npm run test:schema       # スキーマが何度流しても安全か（10件）
```

**期待**：すべて `結果: N件OK / 0件NG`

特に確認している点：
- 回転日数の中央値（外れ値1件に引っ張られないか）
- 中古を除いても**新品率の分母には中古を残す**か（ここを間違えると新品率が必ず100%になる）
- 回転0日で月販が発散しないか（下限0.5日）

---

## テスト2: 実際のメルカリから取得（DBに書かない・約1分）

```bash
npm run scrape:search -- --keyword "スマホ スタンド" --pages 2 --sellers 5 --dry
```

**期待する出力**：
```
=== 3-1 セラーリサーチ ===
  キーワード : スマホ スタンド
  ページ数   : 2
  商品状態   : 中古は売上件数から除外(新品率は全件で計算)

  検索: "スマホ スタンド" 1/2ページ目
  配送方法マスタを取得(21種)
  → 111件(新規111件, 累計111件)
  検索: "スマホ スタンド" 2/2ページ目
  → 111件(新規111件, 累計222件)
検索完了: 222件中 売れた出品 222件 / セラー 203人

--- 集計 ---
  出品 222件 / セラー 115人
  内訳: 中堅特化 2人 / 小規模/単発 113人

--- 結果(上位20人) ---
  セラー名	SOLD	平均価格	回転日数	新品率	分類
  Sundear　メルカリ店	4	¥3,398	0日	100%	中堅特化
  ...

--dry のためDBには書き込みませんでした。
所要 70秒
```

### ここで確認すること（仕様の充足）

| 仕様書の要件 | 確認方法 | 合格の目安 |
|---|---|---|
| **キーワードで SOLD を検索** | `検索完了: N件中 売れた出品 N件` | 売れた出品が0でない |
| **新しい順** | URLに `sort=created_time&order=desc` が入っている | ソースの `buildSearchUrl` を参照 |
| **指定ページ数（目安10）** | `1/2ページ目` `2/2ページ目` と出る | 指定した数だけ回る |
| **各商品について出品者が分かる** | `セラー 203人` が出品件数に対して妥当 | **セラー数 > 0 かつ 出品数以下**。ここが従来は上位30件しか解決できていなかった |
| **複数キーワード** | 下の「あるあるワード」の例を実行 | 組み合わせごとに検索される |

### バリエーション

```bash
# あるあるワードとの組み合わせ（「スマホ スタンド インポート」「スマホ スタンド 海外」の2通りを検索）
npm run scrape:search -- --keyword "スマホ スタンド" --aruaru "インポート" "海外" --pages 2 --dry

# 中古も売上件数に含める（せどり用途）
npm run scrape:search -- --keyword "トレカ" --pages 2 --used --dry

# 仕様書どおり10ページ（1キーワードで約1,100件。5分ほどかかります）
npm run scrape:search -- --keyword "スマホ スタンド" --pages 10 --sellers 60 --dry

# ブラウザの動きを目で見る
npm run scrape:search -- --keyword "スマホ スタンド" --pages 1 --headed --dry

# ブロックされやすい時は間隔を広げる
npm run scrape:search -- --keyword "スマホ スタンド" --pages 3 --interval 8000 --dry
```

---

## テスト3: DBに保存して画面で見る（約2分）

`--dry` を外すと保存されます。

```bash
npm run scrape:search -- --keyword "スマホ スタンド" --pages 2 --sellers 10
```

**期待する末尾**：
```
--- DBへ投入 ---
セラー: 10件を登録/更新
出品: 137件を新規登録(既存のためスキップ 0件)
セラー集計: 10件を保存
searches.id = 1
```

**保存内容を確認**：
```bash
npm run db:stats
```
`sellers` `listings` `seller_research_results` の行数が増えていれば成功です。

**画面で見る**：
```bash
npm run build
npm run start
```
→ ブラウザで `http://localhost:3000` を開く
→ セラー名・総SOLD・平均価格・回転日数・新品率の一覧が出れば完了

---

## テスト4: ジョブキュー経由（画面と同じ経路・約2分）

実運用では、画面がジョブを積み、ワーカーが拾って処理します。その経路を確認します。

**ターミナル1（ワーカー）**
```bash
npm run worker
```
```
[20:15:01] ワーカーを開始しました (id=xxx-1234, ページ間隔=5000ms)
[20:15:01] 待機中(ジョブなし)
```

**ターミナル2（画面のAPIを叩く）**
```bash
npm run start    # 別ウィンドウで起動しておく

curl -X POST http://localhost:3000/api/jobs ^
  -H "Content-Type: application/json" ^
  -d "{\"kind\":\"search\",\"keyword\":\"スマホ スタンド\",\"pages\":2,\"sellers\":5}"
```
→ `{"jobId":1,"seq":1,"label":"リサーチ：スマホ スタンド（2ページ）"}`

ターミナル1に `ジョブ #1 [search] を開始` と出れば連携できています。

**進捗を見る**
```bash
curl "http://localhost:3000/api/jobs?id=1"
```
```json
{
  "job": {
    "id": 1, "status": "running",
    "progress": { "phase": "crawl", "i": 1, "n": 2, "label": "スマホ スタンド（累計111件）" },
    "log": ["検索を開始します: \"スマホ スタンド\"", "  検索: ..."]
  },
  "queueAhead": 0
}
```

`phase` は `crawl`（巡回）→ `aggregate`（集計）→ `names`（セラー名取得）→ `save`（保存）と進み、
最後に `status: "done"` と `result` が入ります。

**履歴一覧**
```bash
curl "http://localhost:3000/api/jobs?limit=10"
```

---

## うまくいかないとき

| 症状 | 原因と対処 |
|---|---|
| `Could not find the 'is_new' column` | スキーマ未適用。`npm run db:push` → `npm run db:check` |
| `検索結果を取得できませんでした` | メルカリ側の仕様変更か、アクセス制限。`--interval 8000` で試し、それでも駄目なら時間をおく |
| `サイト側にアクセスを拒否されました (HTTP 403)` | ブロックされています。**しばらく間隔を空けてください**。ワーカーは自動で10分待機します |
| 取得0件 | キーワードでSOLDが無い可能性。メルカリで手動検索して確認 |
| ジョブが `queued` のまま | ワーカーが動いていません。`npm run worker` |
| `browserType.launch: Executable doesn't exist` | `npx playwright install chromium` |

---

## この機能の仕様上の制限

| 項目 | 内容 |
|---|---|
| **売却日時** | メルカリが公開していないため取得不可。`listings.updated_at`（最終更新日時）を回転日数の**推定**に使用。値下げなどでも更新される点に注意 |
| **セラー名** | 検索結果に含まれないため、集計後の上位N人（既定60人）だけプロフィールを開いて取得。それ以外はIDのまま保存 |
| **1ページの件数** | 約110件。10ページで1キーワードあたり約1,100件 |
| **所要時間** | 1ページあたり約5秒＋描画待ち。2ページで約1分、10ページで約5分。セラー名の取得は1人あたり約5秒 |
| **メルカリShops** | 通常出品と名前空間が違うため、セラーIDに `shops:` を付けて区別 |
