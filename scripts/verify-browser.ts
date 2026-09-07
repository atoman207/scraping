/**
 * ブラウザ(Playwright付属のChromium)が起動できるかだけを確かめる。
 *   npm run test:browser
 *
 * メルカリには一切アクセスしない。DBにもつながない。
 * 画面から「リサーチ」を実行したときに
 *   [エラー] browserType.launch: Executable doesn't exist at ...
 * が出たら、まずこれを実行して切り分ける。
 *
 * ここが通るのにリサーチが失敗する場合は、ブラウザではなく
 * 通信内容(ブロック・タイムアウト)の問題なので、ジョブのログを見る。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ScraperSession } from "../lib/scraper/browser";

function line(ok: boolean, label: string, detail?: string) {
  console.log(`  ${ok ? "OK" : "NG"}   ${label}`);
  if (detail) console.log(`       ${detail}`);
}

async function main() {
  console.log("\n===== ブラウザの起動確認 =====\n");

  // ① ブラウザ本体が置かれる場所を見る(入っていなければ、その時点で原因が確定する)
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), "AppData", "Local", "ms-playwright");
  const installed = existsSync(root);
  line(installed, "ブラウザの置き場がある", root);
  if (!installed) {
    console.log("\n  ブラウザ本体が入っていません。次のどちらかを実行してください:");
    console.log("    ・ops\\install-browser.cmd をダブルクリック");
    console.log("    ・このフォルダで  npx playwright install chromium");
    console.log("\n  ※ npm install ではブラウザ本体は入りません(別途ダウンロードが要ります)\n");
    process.exitCode = 1;
    return;
  }

  // ② 実際に起動してみる。ここが本番と同じ経路
  const session = new ScraperSession({ log: (m) => console.log(`       ${m}`) });
  try {
    await session.start();
  } catch (e) {
    line(false, "ブラウザを起動できる");
    console.log(`\n  ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
    return;
  }
  line(true, "ブラウザを起動できる");

  // ③ 後片付けまで通ることを確認する(閉じ損ねるとプロセスが残る)
  await session.close();
  line(true, "ブラウザを終了できる");

  console.log("\n===== 問題ありません。画面からリサーチを実行できます =====\n");
}

main().catch((e) => {
  console.error("\n予期しないエラー:", e);
  process.exitCode = 1;
});
