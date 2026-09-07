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

/** 一時的な失敗として、やり直す価値のあるHTTPステータス */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * 「時計のズレで認証が弾かれた」ことを示す文言。
 *
 * Supabaseは受け取ったAPIキーを内部でJWTに変換して各コンポーネントへ渡す。
 * その**発行時刻**と**検証側の時計**が一瞬ずれると、まだ有効になっていない token として
 * "JWT issued at future" で弾かれる。こちらのPCの時計は関係なく(NTPで合っていても起きる)、
 * 数百ミリ秒待ってやり直せば通る。
 */
const CLOCK_SKEW = /issued at future|token used before issued|not yet valid|clock skew/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 1回目150ms、2回目300ms待つ */
const backoff = (attempt: number) => 150 * 2 ** (attempt - 1);

/**
 * Supabaseへの通信。一時的な失敗だけ、控えめにやり直す。
 *
 * ■ なぜ必要か
 *   currentUser() は **すべての画面の描画で呼ばれる**(app/(app)/layout.tsx)。
 *   ここが一度でも失敗すると画面全体が500になる。上流の一瞬の不調で
 *   アプリ全体が落ちるのは割に合わないので、この層で吸収する。
 *
 * ■ やり直してよい条件(書き込みを二重に適用しないための線引き)
 *   ・認証の段階で弾かれた(401/403)かつ時計のズレが原因 …… **常にやり直す**。
 *     この場合リクエストはDBに届いていないので、書き込みでも重複しない。
 *   ・5xx / 429 などのサーバー側の不調 …… **読み取り(GET/HEAD)だけ**。
 *     書き込みは、届いた後に応答だけ失敗した可能性を否定できないため。
 *   ・応答が返る前の通信エラー …… 同じ理由で読み取りだけ。
 *   それ以外(404・列が無い等の恒久的なエラー)はやり直さず、そのまま返す。
 */
async function fetchWithRetry(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  const idempotent = method === "GET" || method === "HEAD";
  const maxAttempts = 3;

  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      // Next.jsはグローバルのfetchをラップして結果をキャッシュするため、
      // 何もしないとサーバーコンポーネントが古いDBの内容を表示し続ける。
      // DBの読み書きは常に最新であるべきなので no-store を明示する。
      res = await fetch(input, { ...init, cache: "no-store" });
    } catch (e) {
      if (!idempotent || attempt >= maxAttempts) throw e;
      await sleep(backoff(attempt));
      continue;
    }

    if (res.ok || attempt >= maxAttempts) return res;

    if (res.status === 401 || res.status === 403) {
      // 本文を読むと元の res が消費されるので、複製の方を読む
      const body = await res.clone().text().catch(() => "");
      if (CLOCK_SKEW.test(body)) {
        await sleep(backoff(attempt));
        continue;
      }
      return res;
    }

    if (RETRYABLE_STATUS.has(res.status) && idempotent) {
      await sleep(backoff(attempt));
      continue;
    }
    return res;
  }
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
      // キャッシュ無効化と、一時的な失敗のやり直しは fetchWithRetry に集約している
      fetch: (input, init) => fetchWithRetry(input, init),
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
  if (CLOCK_SKEW.test(message)) {
    return (
      `${message}\n` +
      `  → Supabase側の一時的な時刻ズレです(こちらのPCの時計とは無関係)。\n` +
      `     自動で数回やり直しているので、これが出たのは連続で失敗した場合です。\n` +
      `     何度も出るときは、このPCの時計も確認してください: w32tm /query /status`
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
