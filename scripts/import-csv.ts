/**
 * scraper/import_csv.py のTypeScript移植。
 * CSVをDB(sellers/listings)に取り込む。
 *
 * listings用CSVカラム(元と同じ):
 *   platform,external_id,seller_external_id,seller_name,seller_rating,seller_review_count,
 *   title,price,status,listed_at,sold_at,shipping_cost,image_url,listing_url
 *
 * 使い方:
 *   npm run import:csv -- --csv data/listings_sample.csv
 *   (元の --db は不要。接続先は .env.local の Supabase 設定を使う)
 */
import "./_env";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs, argOne, requireArg, projectRoot } from "./_env";
import { getSupabase, must } from "../lib/supabase";
import { parseCsv } from "../lib/engine/csv";

async function getOrCreateSeller(
  platform: string,
  sellerExternalId: string,
  sellerName: string,
  rating: string,
  reviewCount: string
): Promise<number> {
  const sb = getSupabase();
  const found = must(
    await sb
      .from("sellers")
      .select("id")
      .eq("platform", platform)
      .eq("seller_external_id", sellerExternalId)
      .maybeSingle()
  ) as { id: number } | null;
  if (found) return found.id;

  const created = must(
    await sb
      .from("sellers")
      .insert({
        platform,
        seller_external_id: sellerExternalId,
        seller_name: sellerName,
        rating: rating ? Number(rating) : null,
        review_count: reviewCount ? parseInt(reviewCount, 10) : null,
      })
      .select("id")
      .single()
  ) as { id: number };
  return created.id;
}

async function run(csvPath: string) {
  const sb = getSupabase();
  const rows = parseCsv(readFileSync(csvPath, "utf8"));

  let inserted = 0;
  for (const row of rows) {
    const sellerId = await getOrCreateSeller(
      row["platform"],
      row["seller_external_id"],
      row["seller_name"],
      row["seller_rating"] ?? "",
      row["seller_review_count"] ?? ""
    );
    try {
      // 元: INSERT OR IGNORE INTO listings (...) -> upsert + ignoreDuplicates
      const res = await sb
        .from("listings")
        .upsert(
          {
            seller_id: sellerId,
            platform: row["platform"],
            external_id: row["external_id"],
            title: row["title"],
            price: Number(row["price"]),
            status: row["status"],
            listed_at: row["listed_at"] || null,
            sold_at: row["sold_at"] || null,
            shipping_cost: row["shipping_cost"] ? Number(row["shipping_cost"]) : null,
            image_url: row["image_url"] || null,
            listing_url: row["listing_url"] || null,
          },
          { onConflict: "platform,external_id", ignoreDuplicates: true }
        )
        .select("id");
      const data = must(res) as { id: number }[] | null;
      inserted += data ? data.length : 0;
    } catch (e) {
      console.log(`スキップ: ${row["external_id"]} (${e})`);
    }
  }

  console.log(`取り込み完了: ${inserted}/${rows.length}件`);
  console.log("次: npm run engine:cluster -- --seller_id <ID>");
}

function resolveCsv(p: string): string {
  const fromCwd = path.resolve(process.cwd(), p);
  return existsSync(fromCwd) ? fromCwd : path.join(projectRoot, p);
}

const args = parseArgs(process.argv.slice(2));
if (argOne(args, "db")) {
  console.log("(注) --db は無視されます。接続先は .env.local の Supabase 設定です。");
}
const csv = requireArg(args, "csv");
run(path.isAbsolute(csv) ? csv : resolveCsv(csv)).catch((e) => {
  console.error(e);
  process.exit(1);
});
