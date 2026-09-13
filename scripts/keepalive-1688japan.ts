/**
 * 1688Japan のセッションを生かし続ける。
 *   npm run keepalive:1688jp
 *
 * ■ 何をするか
 *   いちばん軽い呼び出し(getUserInfo)を1回だけ通して、結果を記録する。
 *
 *   ・相手が「使うたびに期限を延ばす」作りなら、これで**期限が来なくなる**
 *   ・そうでなくても、切れたその日のうちに気づける(画面とログに出る)
 *
 * ■ いつ動かすか
 *   常駐ワーカー(`npm run worker`)が1日1回これと同じ処理を通すので、
 *   ワーカーを動かしているなら別途の設定は要らない。
 *   ワーカーを使わない構成では、タスクスケジューラで1日1回このコマンドを叩く。
 *
 * ■ 終了コード
 *   0 … 通った
 *   1 … 通らなかった(入り直しが必要)
 *   監視ツールから叩いて、1 が返ったら通知する、という使い方を想定している。
 */
import "./_env";
import { touchSession, WARN_DAYS } from "../lib/scraper/session-1688jp";

async function main() {
  const r = await touchSession();
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);

  if (!r.ok) {
    console.error(`[${now}] NG  ${r.reason}`);
    console.error(`           npm run login:1688jp で入り直してください。`);
    process.exit(1);
  }

  const left = r.daysLeft === null ? "" : ` / 記載上の期限まで約${Math.floor(r.daysLeft)}日`;
  console.log(`[${now}] OK  ${r.user} として接続できています${left}`);

  if (r.warn) {
    console.warn(
      `           残りが${WARN_DAYS}日を切っています。都合のよいときに ` +
        `npm run login:1688jp で入り直しておくと安心です。`
    );
  }
}

main().catch((e) => {
  console.error("生存確認に失敗しました:", e instanceof Error ? e.message : e);
  process.exit(1);
});
