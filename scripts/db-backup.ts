/**
 * DBのバックアップと復元。
 *   npm run db:backup              … backups/YYYY-MM-DD_HHmm/ にJSONで書き出す
 *   npm run db:backup -- --restore backups/2026-09-03_1930   … 書き戻す
 *   npm run db:backup -- --list    … 取得済みのバックアップ一覧
 *
 * なぜ必要か:
 *   Supabaseの無料プランには**自動バックアップが無い**。
 *   誤操作やプロジェクト削除でデータが消えると戻せないため、
 *   VPS内にも定期的に控えを取っておく。
 *
 * 形式はテーブルごとのJSON。件数が少ないうちはこれで十分で、
 * pg_dump のようにPostgreSQLのバージョンに依存しない利点もある。
 */
import "./_env";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getSupabase, must } from "../lib/supabase";
import { parseArgs, argOne, projectRoot } from "./_env";

/** 依存関係の順。復元はこの順で入れる(親→子) */
const TABLES = [
  "settings",
  "searches",
  "sellers",
  "listings",
  "product_groups",
  "seller_research_results",
  "deepdive_items",
  "jobs",
];

const BACKUP_ROOT = path.join(projectRoot, "backups");
/** 1回に読む件数。大きすぎるとタイムアウトする */
const PAGE = 1000;
/** 残す世代数。これより古いものは消す */
const KEEP_GENERATIONS = 14;

const args = parseArgs(process.argv.slice(2));

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

async function dumpTable(table: string): Promise<unknown[] | null> {
  const sb = getSupabase();
  const rows: unknown[] = [];
  for (let from = 0; ; from += PAGE) {
    const res = await sb.from(table).select("*").range(from, from + PAGE - 1);
    if (res.error) return null; // テーブルが無い等
    const chunk = res.data ?? [];
    rows.push(...chunk);
    if (chunk.length < PAGE) break;
  }
  return rows;
}

async function backup() {
  const dir = path.join(BACKUP_ROOT, stamp());
  mkdirSync(dir, { recursive: true });
  console.log(`\n=== バックアップ: ${dir} ===`);

  let total = 0;
  const summary: Record<string, number | string> = {};
  for (const t of TABLES) {
    const rows = await dumpTable(t);
    if (rows === null) {
      summary[t] = "未作成";
      console.log(`  ${t.padEnd(26)} —  未作成のため飛ばしました`);
      continue;
    }
    writeFileSync(path.join(dir, `${t}.json`), JSON.stringify(rows, null, 1), "utf8");
    summary[t] = rows.length;
    total += rows.length;
    console.log(`  ${t.padEnd(26)} ${String(rows.length).padStart(8)}行`);
  }
  writeFileSync(
    path.join(dir, "_meta.json"),
    JSON.stringify({ takenAt: new Date().toISOString(), total, tables: summary }, null, 2),
    "utf8"
  );
  console.log(`  合計 ${total}行を保存しました`);

  // 古い世代を片付ける
  const gens = listBackups();
  const stale = gens.slice(KEEP_GENERATIONS);
  if (stale.length) {
    console.log(`\n  古いバックアップ ${stale.length}件は残しています(自動削除はしません):`);
    for (const g of stale.slice(0, 5)) console.log(`    ${g}`);
    console.log(`  不要なら backups/ から手で削除してください。`);
  }
  console.log("");
}

function listBackups(): string[] {
  if (!existsSync(BACKUP_ROOT)) return [];
  return readdirSync(BACKUP_ROOT)
    .filter((f) => statSync(path.join(BACKUP_ROOT, f)).isDirectory())
    .sort()
    .reverse();
}

async function restore(dir: string) {
  const abs = path.isAbsolute(dir) ? dir : path.join(projectRoot, dir);
  if (!existsSync(abs)) {
    console.error(`見つかりません: ${abs}`);
    process.exit(1);
  }
  console.log(`\n=== 復元: ${abs} ===`);
  console.log("  既存の行は同じ主キーで上書きされます。消えた行が戻るだけで、余分な行は消しません。\n");

  const sb = getSupabase();
  for (const t of TABLES) {
    const f = path.join(abs, `${t}.json`);
    if (!existsSync(f)) {
      console.log(`  ${t.padEnd(26)} —  ファイルなし`);
      continue;
    }
    const rows = JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>[];
    if (!rows.length) {
      console.log(`  ${t.padEnd(26)} 0行`);
      continue;
    }
    let done = 0;
    let failed = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const res = await sb.from(t).upsert(rows.slice(i, i + 200));
      if (res.error) {
        failed += Math.min(200, rows.length - i);
        if (failed <= 200) console.log(`  ${t.padEnd(26)} 失敗: ${res.error.message.slice(0, 70)}`);
      } else {
        done += Math.min(200, rows.length - i);
      }
    }
    console.log(`  ${t.padEnd(26)} ${String(done).padStart(8)}行を復元` + (failed ? ` (失敗${failed}行)` : ""));
  }
  console.log("");
}

async function main() {
  if (args["list"]) {
    const gens = listBackups();
    console.log(`\n=== バックアップ一覧 (${BACKUP_ROOT}) ===`);
    if (!gens.length) console.log("  まだありません。npm run db:backup で取得してください。");
    for (const g of gens) {
      const meta = path.join(BACKUP_ROOT, g, "_meta.json");
      const info = existsSync(meta) ? (JSON.parse(readFileSync(meta, "utf8")) as { total: number }) : null;
      console.log(`  ${g}  ${info ? `${info.total}行` : ""}`);
    }
    console.log("");
    return;
  }
  const target = argOne(args, "restore");
  if (target) {
    await restore(target);
    return;
  }
  await backup();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
