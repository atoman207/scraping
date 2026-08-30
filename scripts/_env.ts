/** CLIスクリプト用: .env.local -> .env の順で環境変数を読み込む(Next.jsと同じ優先順) */
import { existsSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

const root = path.join(__dirname, "..");
for (const f of [".env.local", ".env"]) {
  const p = path.join(root, f);
  if (existsSync(p)) dotenv.config({ path: p });
}

/** "--key value" 形式の簡易パーサ(Pythonのargparse相当) */
export function parseArgs(argv: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let key: string | null = null;
  for (const a of argv) {
    if (a.startsWith("--")) {
      key = a.slice(2);
      out[key] = out[key] ?? [];
    } else if (key) {
      out[key].push(a);
    }
  }
  return out;
}

export function argOne(args: Record<string, string[]>, name: string): string | undefined {
  const v = args[name];
  return v && v.length ? v[0] : undefined;
}

export function requireArg(args: Record<string, string[]>, name: string): string {
  const v = argOne(args, name);
  if (v === undefined) {
    console.error(`エラー: --${name} は必須です`);
    process.exit(2);
  }
  return v;
}

export { root as projectRoot };
