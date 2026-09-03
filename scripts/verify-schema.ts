/**
 * supabase/schema.sql の静的検査。
 *   npm run test:schema
 *
 * 「2回流すとエラーになる書き方」を機械的に見つける。
 * PostgreSQL に実際につながなくても、よくある事故は事前に潰せる。
 *
 * 検査する内容:
 *   1. CREATE TABLE に IF NOT EXISTS が付いているか
 *   2. ADD COLUMN に IF NOT EXISTS が付いているか
 *   3. ADD CONSTRAINT が存在チェックの中に入っているか(IF NOT EXISTS が無いため)
 *   4. CREATE OR REPLACE VIEW を使っていないか(列構成を変えられずエラーになる)
 *   5. ビューが DROP されてから CREATE されているか
 *   6. CREATE INDEX に IF NOT EXISTS が付いているか
 *   7. CREATE TRIGGER の前に DROP TRIGGER があるか
 *   8. ドル引用符($$)が閉じているか
 *   9. 外部キーの参照先が、参照する前に定義されているか
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const SQL_PATH = path.join(__dirname, "..", "supabase", "schema.sql");
const raw = readFileSync(SQL_PATH, "utf8");

/** コメントを取り除いた本文(検査はこちらに対して行う) */
const sql = raw
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n")
  .replace(/\/\*[\s\S]*?\*\//g, "");

let pass = 0;
let fail = 0;
const problems: string[] = [];

function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  OK  ${label}`);
  } else {
    fail++;
    problems.push(`${label}${detail ? `\n        ${detail}` : ""}`);
    console.log(`  NG  ${label}${detail ? `\n        ${detail}` : ""}`);
  }
}

console.log(`\n=== supabase/schema.sql の検査 ===`);
console.log(`  ${raw.split("\n").length}行 / ${(raw.length / 1024).toFixed(1)}KB\n`);

// 1. CREATE TABLE
{
  const all = [...sql.matchAll(/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?([a-z_]+)/gi)];
  const bad = all.filter((m) => !m[1]).map((m) => m[2]);
  check(`CREATE TABLE ${all.length}件すべてに IF NOT EXISTS がある`, bad.length === 0, bad.join(", "));
}

// 2. ADD COLUMN
{
  const all = [...sql.matchAll(/ADD\s+COLUMN\s+(IF\s+NOT\s+EXISTS\s+)?([a-z_]+)/gi)];
  const bad = all.filter((m) => !m[1]).map((m) => m[2]);
  check(`ADD COLUMN ${all.length}件すべてに IF NOT EXISTS がある`, bad.length === 0, bad.join(", "));
}

// 3. ADD CONSTRAINT は存在チェックの中にあるか
//    ALTER TABLE ... ADD CONSTRAINT には IF NOT EXISTS が無いので、
//    pg_constraint を見る DO ブロックの中に入っている必要がある。
{
  const all = [...sql.matchAll(/ADD\s+CONSTRAINT\s+([a-z_]+)/gi)].map((m) => m[1]);
  const guarded = new Set(
    [...sql.matchAll(/conname\s*=\s*'([a-z_]+)'/gi)].map((m) => m[1])
  );
  const bad = all.filter((c) => !guarded.has(c));
  check(
    `ADD CONSTRAINT ${all.length}件すべてが存在チェックで守られている`,
    bad.length === 0,
    bad.length ? `守られていない制約: ${bad.join(", ")}（2回目の実行でエラーになります）` : ""
  );
}

// 4. CREATE OR REPLACE VIEW を使っていないか
//    既存ビューの列を「同じ名前・型・順序」で保ったまま末尾に足すことしかできず、
//    列構成を変えると cannot change name of view column でエラーになる。
{
  const bad = [...sql.matchAll(/CREATE\s+OR\s+REPLACE\s+VIEW\s+([a-z_]+)/gi)].map((m) => m[1]);
  check(
    `CREATE OR REPLACE VIEW を使っていない`,
    bad.length === 0,
    bad.length ? `${bad.join(", ")} → DROP VIEW IF EXISTS してから CREATE VIEW にしてください` : ""
  );
}

// 5. ビューは DROP されてから CREATE されているか
{
  const created = [...sql.matchAll(/CREATE\s+VIEW\s+([a-z_]+)/gi)].map((m) => m[1]);
  const bad: string[] = [];
  for (const v of created) {
    const dropAt = sql.search(new RegExp(`DROP\\s+VIEW\\s+IF\\s+EXISTS\\s+${v}`, "i"));
    const createAt = sql.search(new RegExp(`CREATE\\s+VIEW\\s+${v}`, "i"));
    if (dropAt < 0 || dropAt > createAt) bad.push(v);
  }
  check(`ビュー ${created.length}件が DROP → CREATE の順になっている`, bad.length === 0, bad.join(", "));
}

// 6. CREATE INDEX
{
  const all = [...sql.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX\s+(IF\s+NOT\s+EXISTS\s+)?([a-z_]+)/gi)];
  const bad = all.filter((m) => !m[2]).map((m) => m[3]);
  check(`CREATE INDEX ${all.length}件すべてに IF NOT EXISTS がある`, bad.length === 0, bad.join(", "));
}

// 7. CREATE TRIGGER の前に DROP TRIGGER
{
  const created = [...sql.matchAll(/CREATE\s+TRIGGER\s+([a-z_]+)/gi)].map((m) => m[1]);
  const bad = created.filter((t) => !new RegExp(`DROP\\s+TRIGGER\\s+IF\\s+EXISTS\\s+${t}`, "i").test(sql));
  check(`トリガ ${created.length}件が DROP → CREATE の順になっている`, bad.length === 0, bad.join(", "));
}

// 8. ドル引用符が閉じているか
{
  const n = (raw.match(/\$\$/g) ?? []).length;
  check(`ドル引用符($$)が閉じている（${n}個 = 偶数）`, n % 2 === 0, n % 2 ? "奇数個あります" : "");
}

// 9. 外部キーの参照先が、参照する前に定義されているか
{
  const order: string[] = [...sql.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z_]+)/gi)].map((m) => m[1]);
  const bad: string[] = [];
  const tableBlocks = [...sql.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z_]+)\s*\(([\s\S]*?)\n\);/gi)];
  for (const [, table, body] of tableBlocks) {
    for (const ref of [...body.matchAll(/REFERENCES\s+([a-z_]+)/gi)].map((m) => m[1])) {
      if (ref === table) continue; // 自己参照は問題ない
      const iRef = order.indexOf(ref);
      const iSelf = order.indexOf(table);
      if (iRef < 0) bad.push(`${table} → ${ref}(定義が見つかりません)`);
      else if (iRef > iSelf) bad.push(`${table} → ${ref}(参照先の方が後ろで定義されています)`);
    }
  }
  check(`外部キーの参照先が先に定義されている`, bad.length === 0, bad.join(" / "));
}

// 10. 分割していたマイグレーションの残骸が無いか
{
  const leftovers = ["002_cost_model", "003_listing_signals", "004_jobs", "_migrations-merged"];
  const found = leftovers.filter((f) => raw.includes(f));
  check(`分割マイグレーションへの参照が残っていない`, found.length === 0, found.join(", "));
}

console.log(`\n===== 結果: ${pass}件OK / ${fail}件NG =====`);
if (fail) {
  console.log(`\n直すべき点:`);
  for (const p of problems) console.log(`  ・${p}`);
  console.log("");
  process.exit(1);
}
console.log(`このスキーマは何度実行しても同じ結果になります。\n`);
