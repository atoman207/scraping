# デプロイ手順（Supabase + GitHub + Vercel）

## ⚠️ 最初に：構成上の制約

**Vercel だけでは完結しません。** スクレイピングは Vercel 上で動かせないためです。

| | 理由 |
|---|---|
| 実ブラウザが必要 | Playwright は Chromium のバイナリ(150MB超)を使う。Vercel の関数バンドル上限に収まらず、そもそも同梱されない |
| 実行時間が長い | 1キーワード10ページで約5分、セラー名の取得も含めると10分超。Vercel の関数は最長でも300秒（Hobbyは60秒） |
| 状態を持てない | 関数はリクエストごとに別インスタンス。ブラウザを開いたまま次のリクエストに引き継げない |

そこで**3つに分けます**。これは参考にした Seller Scope と同じ構成です（あちらもVPSで巡回しています）。

```
┌─────────────┐   ジョブを1行入れる    ┌──────────────┐
│  Vercel     │ ──────────────────────▶│              │
│  画面 + API │                        │   Supabase   │
│             │◀────────────────────── │   DB + Queue │
└─────────────┘   進捗をポーリング      └──────────────┘
                                              ▲  │
                             ジョブを拾う ────┘  │ 結果を書く
                                    ┌────────────┴─┐
                                    │  ワーカー     │
                                    │ (PC/VPS常駐)  │
                                    │  Playwright   │
                                    └───────────────┘
```

- **Vercel**: 画面と `/api/jobs`。DBに1行入れて読むだけなので何の問題もなく動く
- **Supabase**: DB兼ジョブキュー
- **ワーカー**: `npm run worker`。常駐できてブラウザを起動できる場所で動かす

### ワーカーをどこで動かすか

| 選択肢 | 費用 | 備考 |
|---|---|---|
| **今お使いのWindows PC/サーバー** | 無料 | まずはこれで十分。PCを起動している間だけ動く |
| VPS（さくら・ConoHa・Hetzner等） | 月500〜1,000円 | 24時間動かすならこれ。Seller Scope もVPS |
| Railway / Render / Fly.io | 月$5前後 | Dockerで動かす。手軽 |

---

## 手順

### 1. Supabase（DB）

すでにプロジェクトは作成済みで、`.env.local` に接続情報が入っています。
**追加したテーブル・列を反映してください**（まだ未実施）。

```bash
cd tenbai-next
npm run db:migrate
```
→ `supabase/_migrations-merged.sql` が書き出されます。
→ **Supabase ダッシュボード > SQL Editor** を開き、その中身を貼り付けて **Run**。

適用されるもの:
| ファイル | 内容 |
|---|---|
| `002_cost_model.sql` | 原価モデルの列（関税・中国国内送料・梱包費など） |
| `003_listing_signals.sql` | 新品判定・更新日時（新品率と回転日数の計算に必要） |
| `004_jobs.sql` | ジョブキュー（Vercelとワーカーの受け渡し） |

> `.env.local` に `DATABASE_URL`（Supabase > Project Settings > Database > Connection string の URI）を
> 設定しておくと、次回から `npm run db:migrate` が自動で当たります。手貼りは不要になります。

**確認**: SQL Editor で `select * from jobs limit 1;` がエラーにならなければ成功です。

---

### 2. GitHub

リポジトリは既にあります: `https://github.com/atoman207/scraping`

```bash
cd tenbai-next
git add -A
git commit -m "セラーリサーチ(3-1)の全件対応とジョブ永続化"
git push origin main
```

> `.env.local` は `.gitignore` 済みなので鍵は上がりません。`sellerscope-out/` も除外済みです。

---

### 3. Vercel（画面）

1. https://vercel.com → **Add New > Project** → GitHubの `atoman207/scraping` を選択
2. **Root Directory** を **`tenbai-next`** に設定（← ここが重要。リポジトリ直下ではありません）
3. Framework Preset は `Next.js` が自動で選ばれます
4. **Environment Variables** に以下を登録（`.env.local` と同じ値）

| 変数名 | 用途 | 必須 |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | SupabaseのプロジェクトURL | ✅ |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role キー（**絶対に公開しない**） | ✅ |
| `BASIC_AUTH_USER` | 画面のBasic認証ID | 推奨 |
| `BASIC_AUTH_PASS` | 画面のBasic認証パスワード | 推奨 |

> **Basic認証は必ず設定してください。** 未設定だと誰でも画面を開けます（`middleware.ts` の仕様）。

5. **Deploy** を押す

**確認**: 発行されたURLを開き、Basic認証を通って「セラーリサーチ」の画面が出ればOK。

---

### 4. ワーカー（スクレイピング）

画面からリサーチを実行しても、**ワーカーが動いていないと順番待ちのまま進みません**。

```bash
cd tenbai-next
npm run worker
```

```
[19:20:11] ワーカーを開始しました (id=WIN-xxxx-12345, ページ間隔=5000ms)
[19:20:11] Ctrl+C で停止します。
[19:20:11] 待機中(ジョブなし)
```

この状態で画面からリサーチを実行すると、ワーカーが拾って処理を始めます。

**初回のみ**: ブラウザ本体が要ります。
```bash
npx playwright install chromium
```

**環境変数**（ワーカー側の `.env.local` に必要）
| 変数名 | 用途 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Vercelと同じ値 |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercelと同じ値 |
| `SCRAPE_INTERVAL_MS` | ページ送りの間隔。既定5000。短くするとブロックされやすい |
| `SCRAPE_COOLDOWN_MS` | ブロックされた後の待機。既定600000（10分） |

**常時起動にする場合**
- Windows: タスクスケジューラで「コンピューターの起動時」に `npm run worker` を実行
- Linux: systemd のサービスにする、または `pm2 start npm -- run worker`

---

## 動作確認（デプロイ後）

```bash
# 1. ワーカーを起動しておく
npm run worker

# 2. 別のターミナルから、Vercelの画面と同じAPIを叩く
curl -X POST https://<あなたのVercel URL>/api/jobs \
  -u "$BASIC_AUTH_USER:$BASIC_AUTH_PASS" \
  -H "Content-Type: application/json" \
  -d '{"kind":"search","keyword":"スマホ スタンド","pages":2,"sellers":10}'
# → {"jobId":1,"seq":1,"label":"リサーチ：スマホ スタンド（2ページ）"}

# 3. 進捗を見る
curl "https://<あなたのVercel URL>/api/jobs?id=1" -u "$BASIC_AUTH_USER:$BASIC_AUTH_PASS"
```

ワーカー側のログに「検索を開始します」と出れば連携できています。

---

## 手動でやっていただく必要があること（まとめ）

| # | 作業 | 所要 | 理由 |
|---|---|---|---|
| 1 | **Supabase SQL Editor にマイグレーションを貼って実行** | 3分 | `DATABASE_URL` が未設定のため自動適用できない。設定していただければ次回から不要 |
| 2 | **Vercel でプロジェクト作成・環境変数の登録** | 10分 | Vercelアカウントの操作は代行できない |
| 3 | **Vercel の Root Directory を `tenbai-next` に設定** | – | 見落としやすい。ここを間違えるとビルドが失敗します |
| 4 | **ワーカーを動かす場所を決めて常駐させる** | 5分〜 | まずは今のPCで `npm run worker` で十分 |
| 5 | `npx playwright install chromium`（ワーカー側で初回のみ） | 2分 | ブラウザ本体のダウンロード |

---

## 既知の制限（発注仕様書 5. の「既知の制限事項」）

| 項目 | 状況 |
|---|---|
| **売却日時** | メルカリが公開していないため取得不可。代わりに最終更新日時を保存し、回転日数の**推定**に使っている（`listings.updated_at`）。「出品から最後に動きがあるまでの日数」なので、値下げ等でも更新される点に注意 |
| **セラー名** | 検索結果には含まれないため、集計後の上位N人だけプロフィールを開いて取得する（既定60人）。それ以外はIDのまま |
| **実送料** | 3-2 の `getRealShippingCost` で取得。普通郵便・定形外・取引未完了は仕様上取得できない |
| **メルカリShops** | 通常出品と名前空間が違うため `shops:` を付けて区別している |
| **サイト構造の変更** | 検索レスポンスの形が変わると `parseSearchResponse` が0件を返す。その場合ジョブはエラーで止まり、ログに「検索結果を取得できませんでした」と出る（黙って壊れない設計） |
| **アクセス制限** | 403/429/503 を受けたら `BlockedError` で即停止し、ワーカーは10分待機する |

## 規約についての技術者としての見解（発注仕様書 6.）

- 取得しているのは**ログイン不要で誰でも見られる公開ページの情報のみ**です。会員限定情報や個人情報（氏名・住所等）は取得していません。
- 認証を回避したり、アクセス制限を迂回する処理は入れていません。403等を受けたら**止まります**。
- 取得方法は「検索ページを普通に開き、そのページが描画のために受け取ったデータを読む」もので、**追加のリクエストは発生しません**（アクセス回数はページを開く回数のみ）。
- 一方で、メルカリの利用規約には自動化されたアクセスを制限する条項が置かれるのが一般的です。**規約解釈と実施可否の最終判断は発注者様側でお願いします**（仕様書6.のとおり）。商用提供される場合は、事前に規約をご確認いただくことを強くおすすめします。
