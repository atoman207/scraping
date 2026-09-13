/**
 * 1688Japan のセッションの面倒をみる。
 *
 * ■ 何が「期限」なのか
 *   保存したファイルには、ログイン時に受け取った Cookie が入っている。
 *   そのうち API が使うのは `token` の値ひとつだけで、中身は
 *   `<利用者ID>@<キー>` という **アカウントに紐づいた鍵**。
 *
 *   Cookie には「30日」という期限が付いているが、それは
 *   **ブラウザがその Cookie を捨てる日** を表しているだけ。
 *   こちらはブラウザを使わず、ファイルから読んだ文字列をヘッダーに載せて送るので、
 *   その日付そのものはこちらの動作を止めない。
 *
 *   止まるとしたら「相手のサーバーが鍵を無効にしたとき」で、
 *   それがいつ起きるかは外からは分からない。そこで次の3つで備える。
 *
 *     1. 生存確認(touch)  … 毎日1回だけ軽い呼び出しを通す。
 *                            使うたびに期限が延びる作りなら、これで延び続ける。
 *     2. 早めの警告        … 最後に通った日と、Cookie上の期限を記録し、
 *                            残り7日を切ったら画面とログで知らせる。
 *     3. 入り直しを簡単に  … `npm run login:1688jp` でID/パスワードを自動で入れる。
 *                            画像の確認コードだけ人が打てば終わる(数十秒)。
 *
 * ■ やらないこと
 *   確認コード(画像認証)の自動突破はしない。相手が人の操作を求めている以上、
 *   そこは人がやる。その代わり、突然切れて困らないようにしてある。
 */
import fs from "node:fs";
import path from "node:path";

const API_BASE = "https://api.hhocool.com/omni-center/hz/api/taotaro";
const SITE = "https://pro.1688japan.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/** 残りがこの日数を切ったら警告を出す */
export const WARN_DAYS = 7;

export type StateFile = {
  cookies?: { name: string; value: string; expires?: number }[];
  origins?: unknown[];
};

/** セッションの置き場所。VPSでは別の場所に置くこともあるので環境変数で差し替えられる */
export function sessionPath(): string {
  return (
    process.env.SOURCING_1688JP_STATE ||
    path.join(process.cwd(), "secrets", "1688japan-state.json")
  );
}

/** 生存確認の結果を書き残す場所(セッション本体とは別。こちらは秘密ではない) */
function statusPath(): string {
  return sessionPath().replace(/\.json$/, "") + "-status.json";
}

export type SessionStatus = {
  /** 最後に相手のAPIが通った日時(ISO) */
  lastOkAt: string | null;
  /** そのときの利用者名 */
  user: string | null;
  /** 最後に確認して駄目だった理由 */
  lastError: string | null;
  /** Cookie に書かれている期限(ISO)。目安として画面に出す */
  cookieExpiresAt: string | null;
};

const EMPTY: SessionStatus = { lastOkAt: null, user: null, lastError: null, cookieExpiresAt: null };

export function readStatus(): SessionStatus {
  try {
    return { ...EMPTY, ...(JSON.parse(fs.readFileSync(statusPath(), "utf8")) as SessionStatus) };
  } catch {
    return { ...EMPTY };
  }
}

function writeStatus(s: SessionStatus): void {
  try {
    fs.mkdirSync(path.dirname(statusPath()), { recursive: true });
    fs.writeFileSync(statusPath(), JSON.stringify(s, null, 1));
  } catch {
    /* 記録できなくても本体は動く */
  }
}

/** セッションが無い/切れているときのエラー。画面にそのまま出せる文言にする */
export class Missing1688JpSession extends Error {
  constructor(reason: string) {
    super(
      `${reason} 1688Japan に入り直してください(\`npm run login:1688jp\` を実行し、開いた画面で確認コードを入れます)。`
    );
    this.name = "Missing1688JpSession";
  }
}

/** 保存したセッションから、APIが要求する token を取り出す */
export function readToken(): string {
  const file = sessionPath();
  if (!fs.existsSync(file)) {
    throw new Missing1688JpSession(`セッションファイルがありません(${file})。`);
  }
  let state: StateFile;
  try {
    state = JSON.parse(fs.readFileSync(file, "utf8")) as StateFile;
  } catch {
    throw new Missing1688JpSession("セッションファイルを読めませんでした。");
  }
  const c = state.cookies?.find((x) => x.name === "token");
  if (!c?.value) throw new Missing1688JpSession("セッションに token がありません。");
  return decodeURIComponent(c.value);
}

/** Cookie に書かれている期限(目安)。分からなければ null */
export function cookieExpiry(): Date | null {
  try {
    const state = JSON.parse(fs.readFileSync(sessionPath(), "utf8")) as StateFile;
    const c = state.cookies?.find((x) => x.name === "token");
    if (!c?.expires || c.expires <= 0) return null;
    return new Date(c.expires * 1000);
  } catch {
    return null;
  }
}

export function apiHeaders(token: string, json = false): Record<string, string> {
  return {
    accept: "application/json, text/plain, */*",
    "accept-language": "ja-JP",
    "x-biz-code": "PROXY_PURCHASE",
    token,
    referer: `${SITE}/`,
    origin: SITE,
    "user-agent": UA,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

export type TouchResult = {
  ok: boolean;
  user?: string;
  reason?: string;
  /** Cookie上の期限まであと何日か(目安)。分からなければ null */
  daysLeft: number | null;
  /** 残りが少ない、または期限を過ぎている */
  warn: boolean;
};

/**
 * 生存確認。いちばん軽い呼び出しを1回だけ通す。
 *
 * 毎日これを通すのは、相手が「使うたびに期限を延ばす」作りだった場合に
 * **期限が来ないようにするため**。そうでなかったとしても、
 * 切れた瞬間をその日のうちに気づけるようになる。
 *
 * 結果はファイルに残すので、画面は相手に問い合わせずに状態を出せる。
 */
export async function touchSession(): Promise<TouchResult> {
  const expiry = cookieExpiry();
  const daysLeft = expiry ? (expiry.getTime() - Date.now()) / 86_400_000 : null;

  let token: string;
  try {
    token = readToken();
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    writeStatus({ ...readStatus(), lastError: reason, cookieExpiresAt: expiry?.toISOString() ?? null });
    return { ok: false, reason, daysLeft, warn: true };
  }

  try {
    const r = await fetch(`${API_BASE}/getUserInfo`, { headers: apiHeaders(token) });
    if (r.status === 401 || r.status === 403) {
      const reason = "1688Japan のセッションが切れています。";
      writeStatus({ ...readStatus(), lastError: reason, cookieExpiresAt: expiry?.toISOString() ?? null });
      return { ok: false, reason, daysLeft, warn: true };
    }
    const j = (await r.json()) as { success?: boolean; data?: { uname?: string; email?: string } };
    if (!j.success) {
      const reason = "1688Japan のセッションが通りませんでした。";
      writeStatus({ ...readStatus(), lastError: reason, cookieExpiresAt: expiry?.toISOString() ?? null });
      return { ok: false, reason, daysLeft, warn: true };
    }
    const user = j.data?.uname || j.data?.email || "(名前不明)";
    writeStatus({
      lastOkAt: new Date().toISOString(),
      user,
      lastError: null,
      cookieExpiresAt: expiry?.toISOString() ?? null,
    });
    return { ok: true, user, daysLeft, warn: daysLeft !== null && daysLeft < WARN_DAYS };
  } catch (e) {
    // 通信できなかっただけかもしれないので、記録は残すが「切れた」とは決めつけない
    const reason = `1688Japan に接続できませんでした: ${String(e instanceof Error ? e.message : e).slice(0, 120)}`;
    writeStatus({ ...readStatus(), lastError: reason });
    return { ok: false, reason, daysLeft, warn: true };
  }
}

/** 画面に出す1行。状態が一目で分かる短い文にする */
export function statusLine(s: SessionStatus): { tone: "ok" | "warn" | "ng"; text: string } {
  if (!s.lastOkAt && s.lastError) return { tone: "ng", text: s.lastError };
  if (!s.lastOkAt) return { tone: "ng", text: "まだ一度も接続できていません。" };

  const days = s.cookieExpiresAt
    ? (new Date(s.cookieExpiresAt).getTime() - Date.now()) / 86_400_000
    : null;
  const when = s.lastOkAt.replace("T", " ").slice(0, 16);

  if (s.lastError) return { tone: "warn", text: `${s.lastError}(最後に通ったのは ${when})` };
  if (days !== null && days < 0) {
    return { tone: "warn", text: `${s.user} として接続中(記載上の期限は過ぎています。切れたら入り直してください)` };
  }
  if (days !== null && days < WARN_DAYS) {
    return { tone: "warn", text: `${s.user} として接続中。あと約${Math.max(0, Math.floor(days))}日で入り直しが必要かもしれません` };
  }
  return {
    tone: "ok",
    text: `${s.user} として接続中${days !== null ? `(目安の期限まで約${Math.floor(days)}日)` : ""} ・ 最終確認 ${when}`,
  };
}
