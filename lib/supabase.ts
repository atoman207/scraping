import { createClient, SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabaseクライアント(サーバー側専用)。
 *
 * 元の webapp/lib/db.ts では better-sqlite3 で data/tenbai.db を開いていたが、
 * ここではその「DBへの入口」をSupabase(PostgreSQL)に置き換えている。
 * Server Component / Server Action / CLIスクリプトからのみ使うこと。
 * service_role キーはRLSをバイパスするため、ブラウザに渡してはいけない。
 */

const URL_ENV = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL"] as const;
const KEY_ENV = ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"] as const;

function pick(names: readonly string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (client) return client;

  const url = pick(URL_ENV);
  const key = pick(KEY_ENV);

  if (!url || !key) {
    throw new Error(
      "Supabaseの接続情報が設定されていません。.env.local に NEXT_PUBLIC_SUPABASE_URL と " +
        "SUPABASE_SERVICE_ROLE_KEY を設定してください(.env.example を参照)。"
    );
  }

  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "public" },
    global: {
      // Next.jsはグローバルのfetchをラップして結果をキャッシュするため、
      // 何もしないとサーバーコンポーネントが古いDBの内容を表示し続ける。
      // DBの読み書きは常に最新であるべきなので no-store を明示する。
      fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }),
    },
  });
  return client;
}

/** 元の getDb() と同じ役割(DBハンドルを返す)。名前は互換のために残している。 */
export const getDb = getSupabase;

/**
 * supabase-jsのエラーを例外にして、画面のエラーボックスやワーカーのログに出す。
 *
 * 「列が無い」「テーブルが無い」はマイグレーションの当て忘れが原因なので、
 * 何をすればよいかまで書き添える。原文だけだと
 * "Could not find the 'is_new' column of 'listings' in the schema cache" となり、
 * 何をすれば直るのか分からないため。
 */
export function must<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(explain(res.error.message));
  return res.data as T;
}

/** PostgRESTのエラー文に、対処方法を付け足す */
export function explain(message: string): string {
  const missingColumn = message.match(/Could not find the '([^']+)' column of '([^']+)'/);
  if (missingColumn) {
    return (
      `${message}\n` +
      `  → DBのマイグレーションが未適用です(${missingColumn[2]}.${missingColumn[1]} がありません)。\n` +
      `     npm run db:check で状況を確認し、npm run db:push で適用してください。\n` +
      `     (DATABASE_URL 未設定なら supabase/schema.sql を SQL Editor に貼る)`
    );
  }
  const missingTable = message.match(/Could not find the table '([^']+)'/);
  if (missingTable) {
    return (
      `${message}\n` +
      `  → テーブル ${missingTable[1]} がありません。npm run db:push で適用してください。\n` +
      `     (DATABASE_URL 未設定なら supabase/schema.sql を SQL Editor に貼る)`
    );
  }
  if (/Could not find the function public\.(claim_job|queue_ahead)/.test(message)) {
    return (
      `${message}\n` +
      `  → ジョブキューの関数が未作成です。supabase/schema.sql を\n` +
      `     Supabase の SQL Editor で実行してください。`
    );
  }
  return message;
}
