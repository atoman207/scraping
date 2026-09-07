/**
 * ログインまわりのロジックを、DBにつながずに検証する。
 *   npm run test:auth
 *
 * DBを触る関数(createUser など)はここでは扱わない。
 * ここで確かめるのは「パスワードを正しく守れているか」「発行する資格情報が
 * 十分にランダムか」「おかしな入力を弾けるか」の3点で、
 * どれもDBの状態に左右されない。
 */
import {
  generatePassword,
  generateUsername,
  hashPassword,
  validatePassword,
  validateUsername,
  verifyPassword,
} from "../lib/auth";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "  OK  " : "  NG  "} ${label}${cond || !detail ? "" : `\n         ${detail}`}`);
}

async function main() {
  console.log("\n=== 1. パスワードのハッシュ化 ===");

  const stored = await hashPassword("Correct-Horse-42");
  ok("保存形式は scrypt$塩$ハッシュ", /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(stored), stored.slice(0, 40));
  ok("平文を含まない", !stored.includes("Correct-Horse-42"));
  ok("正しいパスワードは通る", await verifyPassword("Correct-Horse-42", stored));
  ok("違うパスワードは通らない", !(await verifyPassword("Correct-Horse-43", stored)));
  ok("空文字は通らない", !(await verifyPassword("", stored)));

  // 同じパスワードでも、塩が違うので保存値は毎回変わる
  const again = await hashPassword("Correct-Horse-42");
  ok("同じパスワードでも保存値は毎回変わる(塩がある)", again !== stored);
  ok("それでも検証は通る", await verifyPassword("Correct-Horse-42", again));

  // 壊れた保存値で例外を投げない(落ちるとログインが500になる)
  ok("保存値が壊れていても false を返すだけ", !(await verifyPassword("x", "not-a-hash")));
  ok("形式違いでも false を返すだけ", !(await verifyPassword("x", "bcrypt$aa$bb")));

  console.log("\n=== 2. 発行する資格情報 ===");

  const users = Array.from({ length: 500 }, () => generateUsername());
  ok("ログインIDが重複しない(500件)", new Set(users).size === 500);
  ok("ログインIDが命名規則を満たす", users.every((u) => /^user-[a-z2-9]{6}$/.test(u)));

  const passwords = Array.from({ length: 500 }, () => generatePassword());
  ok("パスワードが重複しない(500件)", new Set(passwords).size === 500);
  ok("既定の長さは14文字", passwords.every((p) => p.length === 14));
  ok("大文字を必ず含む", passwords.every((p) => /[A-Z]/.test(p)));
  ok("小文字を必ず含む", passwords.every((p) => /[a-z]/.test(p)));
  ok("数字を必ず含む", passwords.every((p) => /[2-9]/.test(p)));
  ok("記号を必ず含む", passwords.every((p) => /[@#%+=?]/.test(p)));

  // 口頭やメモで伝えるときに間違えやすい文字は使わない
  ok(
    "紛らわしい文字(0 O 1 l I)を含まない",
    [...users, ...passwords].every((s) => !/[0O1lI]/.test(s))
  );

  // 「必ず含む4文字」を先頭に固めていないか(混ぜているか)を見る。
  // 混ぜていれば、先頭が大文字になる割合はおよそ 1/14 に散る
  const startsUpper = passwords.filter((p) => /^[A-Z]/.test(p)).length;
  ok(
    `先頭の文字種が偏っていない(大文字始まり ${startsUpper}/500)`,
    startsUpper < 200,
    "必須文字を混ぜずに先頭へ置くと、ここが500に近づく"
  );

  ok("長さを指定できる", generatePassword(24).length === 24);
  ok("短すぎる指定でも10文字は確保する", generatePassword(4).length === 10);

  console.log("\n=== 3. 入力のチェック ===");

  ok("短すぎるIDを弾く", validateUsername("ab") !== null);
  ok("記号入りのIDを弾く", validateUsername("yama da") !== null);
  ok("日本語のIDを弾く", validateUsername("やまだ") !== null);
  ok("長すぎるIDを弾く", validateUsername("a".repeat(33)) !== null);
  ok("普通のIDは通る", validateUsername("yamada_01") === null);
  ok("発行したIDは必ず通る", users.every((u) => validateUsername(u) === null));

  ok("短すぎるパスワードを弾く", validatePassword("short12") !== null);
  ok("8文字は通る", validatePassword("12345678") === null);
  ok("発行したパスワードは必ず通る", passwords.every((p) => validatePassword(p) === null));

  console.log(`\n===== 結果: ${pass}件OK / ${fail}件NG =====\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
