/**
 * ログインと利用者管理。
 *
 * ■ 方針
 *   ・利用者は**自分で登録できない**。管理者が /admin で発行する。
 *   ・ログイン検証用に scrypt ハッシュを保存する。
 *   ・管理者があとから確認できるよう、同じパスワードを AES-GCM でも暗号化して保存する
 *     (鍵は SUPABASE_SERVICE_ROLE_KEY から導出。平文では持たない)。
 *   ・ログイン状態はDBに置いたセッション(token)で管理し、
 *     ブラウザのCookieには token だけを入れる(httpOnly)。
 *
 * ■ なぜ node:crypto の scrypt なのか
 *   bcrypt/argon2 は追加パッケージ(ネイティブビルド)が要る。
 *   scrypt は Node に標準で入っていて、パスワードハッシュ用に設計された
 *   鍵導出関数なので、依存を増やさずに必要な強度が出せる。
 *
 * ■ 注意
 *   このモジュールは **サーバー側専用**。service_role キーでDBを触るので、
 *   クライアントコンポーネントから import してはいけない
 *   (node:crypto を使っているので、間違えればビルドで気づける)。
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomInt,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { cookies, headers } from "next/headers";
import { getSupabase, must } from "./supabase";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number
) => Promise<Buffer>;

/** セッションCookieの名前 */
export const SESSION_COOKIE = "tenbai_session";
/** セッションの有効期間(日) */
const SESSION_DAYS = 30;
/** scrypt の出力長(バイト) */
const KEY_LEN = 64;

export type Role = "admin" | "member";

export type AppUser = {
  id: number;
  username: string;
  role: Role;
  display_name: string | null;
  note: string | null;
  is_active: boolean;
  created_at: string | null;
  last_login_at: string | null;
};

const USER_COLUMNS = "id, username, role, display_name, note, is_active, created_at, last_login_at";

// ---------------------------------------------------------------- パスワード

/**
 * パスワードをハッシュ化する。
 * 保存形式: `scrypt$<salt(hex)>$<hash(hex)>`
 * 塩は利用者ごとに新しく作るので、同じパスワードでも保存値は毎回変わる。
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEY_LEN);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/**
 * パスワードが合っているか。
 * 比較は timingSafeEqual を使う(先頭から何文字合っていたかが応答時間に出ないようにする)。
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  try {
    const salt = Buffer.from(parts[1], "hex");
    const expected = Buffer.from(parts[2], "hex");
    const actual = await scryptAsync(password, salt, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** 管理者向け表示用の暗号化鍵(サービスロールキーから導出) */
function passwordViewKey(): Buffer {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  return createHash("sha256").update(`tenbai-pw-view:${secret}`).digest();
}

/**
 * 管理者確認用にパスワードを暗号化する。
 * 保存形式: `enc$v1$<iv(hex)>$<tag(hex)>$<ciphertext(hex)>`
 */
export function encryptPassword(password: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", passwordViewKey(), iv);
  const enc = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc$v1$${iv.toString("hex")}$${tag.toString("hex")}$${enc.toString("hex")}`;
}

/** 管理者確認用の暗号文を復号する。壊れていれば null */
export function decryptPassword(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const parts = stored.split("$");
  if (parts.length !== 5 || parts[0] !== "enc" || parts[1] !== "v1") return null;
  try {
    const iv = Buffer.from(parts[2], "hex");
    const tag = Buffer.from(parts[3], "hex");
    const data = Buffer.from(parts[4], "hex");
    const decipher = createDecipheriv("aes-256-gcm", passwordViewKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * 管理者が利用者のパスワードを確認する。
 * 既定の管理者は資格情報を画面に出さない。暗号列が無い古い行は null。
 */
export async function revealUserPassword(
  id: number
): Promise<{ ok: true; password: string } | { ok: false; error: string }> {
  const sb = getSupabase();
  const row = must(
    await sb.from("app_users").select("id, username, password_enc").eq("id", id).maybeSingle()
  ) as { id: number; username: string; password_enc: string | null } | null;
  if (!row) return { ok: false, error: "その利用者は見つかりませんでした。" };
  if (isFixedAdmin(row.username)) {
    return { ok: false, error: "既定の管理者アカウントのパスワードは表示できません。" };
  }
  const password = decryptPassword(row.password_enc);
  if (!password) {
    return {
      ok: false,
      error: "この利用者のパスワードはまだ表示用に保存されていません。一度変更すると表示できます。",
    };
  }
  return { ok: true, password };
}

// ---------------------------------------------------------------- 資格情報の生成

/**
 * 紛らわしい文字を除いた英数字。
 * 0/O、1/l/I は口頭やメモで伝えるときに間違えやすいので入れない。
 */
const SAFE_UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const SAFE_LOWER = "abcdefghijkmnopqrstuvwxyz";
const SAFE_DIGIT = "23456789";
const SAFE_SYMBOL = "@#%+=?";

/** 暗号論的乱数で1文字選ぶ(Math.random は使わない) */
function pick(chars: string): string {
  return chars[randomInt(chars.length)];
}

/** 配列を暗号論的乱数でシャッフルする */
function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** ランダムなログインIDを作る(例: user-k7m2qp) */
export function generateUsername(prefix = "user"): string {
  const tail = Array.from({ length: 6 }, () => pick(SAFE_LOWER + SAFE_DIGIT)).join("");
  return `${prefix}-${tail}`;
}

/**
 * ランダムなパスワードを作る。
 * 大文字・小文字・数字・記号を必ず1文字ずつ含めてから残りを埋め、最後に並びを混ぜる。
 * (先頭が必ず大文字、のような偏りを作らないため)
 */
export function generatePassword(length = 14): string {
  const len = Math.max(10, length);
  const all = SAFE_UPPER + SAFE_LOWER + SAFE_DIGIT + SAFE_SYMBOL;
  const required = [pick(SAFE_UPPER), pick(SAFE_LOWER), pick(SAFE_DIGIT), pick(SAFE_SYMBOL)];
  const rest = Array.from({ length: len - required.length }, () => pick(all));
  return shuffle([...required, ...rest]).join("");
}

// ---------------------------------------------------------------- 管理者の初期化

/**
 * 既定の管理者アカウント。**固定値であり、変更できない**。
 *
 * 環境変数でも画面からでも上書きできないようにしてある。
 * (この値は画面には一切表示しない。運用者だけが知っている前提)
 */
export const FIXED_ADMIN_USERNAME = "admin";
export const FIXED_ADMIN_PASSWORD = "Admin";

/** 固定管理者アカウントかどうか(ログインIDの大小文字は区別しない) */
export function isFixedAdmin(username: string | null | undefined): boolean {
  return (username ?? "").trim().toLowerCase() === FIXED_ADMIN_USERNAME;
}

/**
 * 固定の管理者アカウントを用意する。
 *
 * ログイン画面と管理画面を開いたときに呼ぶ。
 * ・いなければ `admin` / `Admin` で作る。
 * ・いれば、ログインIDとパスワードが既定のままかを毎回確かめ、
 *   ずれていれば元に戻す(権限=管理者・有効 も同様)。
 *
 * つまり **このアカウントの資格情報は変更できない**。
 * 環境変数(ADMIN_USERNAME / ADMIN_PASSWORD)も参照しない。
 */
export async function ensureAdminUser(): Promise<{ created: boolean; username: string }> {
  const sb = getSupabase();
  const username = FIXED_ADMIN_USERNAME;

  const existing = must(
    await sb
      .from("app_users")
      .select("id, password_hash, role, is_active")
      .eq("username", username)
      .maybeSingle()
  ) as { id: number; password_hash: string; role: Role; is_active: boolean } | null;

  if (existing) {
    // 既定値からずれていたら戻す(DBを直接書き換えられた場合の保険)
    const patch: Record<string, unknown> = {};
    if (!(await verifyPassword(FIXED_ADMIN_PASSWORD, existing.password_hash))) {
      patch.password_hash = await hashPassword(FIXED_ADMIN_PASSWORD);
    }
    if (existing.role !== "admin") patch.role = "admin";
    if (!existing.is_active) patch.is_active = true;
    if (Object.keys(patch).length > 0) {
      must(await sb.from("app_users").update(patch).eq("id", existing.id).select("id"));
    }
    return { created: false, username };
  }

  must(
    await sb
      .from("app_users")
      .insert({
        username,
        password_hash: await hashPassword(FIXED_ADMIN_PASSWORD),
        role: "admin",
        display_name: "管理者",
        note: "既定の管理者(資格情報は変更できません)",
        is_active: true,
      })
      .select("id")
  );
  return { created: true, username };
}

// ---------------------------------------------------------------- セッション

function expiryDate(): string {
  return new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
}

/**
 * セッションCookieに Secure を付けるかどうかを決める。
 *
 * ■ なぜ固定値ではいけないのか
 *   LAN内の別端末から http://192.168.x.x:3000 のような **平文HTTP** で開いたとき、
 *   Secure を付けたCookieはブラウザが保存しない。すると「ログインは通ったのに
 *   またログイン画面に戻る」という、原因の分かりにくい状態になる。
 *   (localhost だけは例外的に保存されるので、同じ端末では気づけない)
 *   かといって常に外すと、HTTPSで公開したときに盗聴でセッションを盗まれる。
 *   そこで **実際にどの経路で来たリクエストか** を見て決める。
 *
 * ■ 判定の順番
 *   ① COOKIE_SECURE が設定されていればそれに従う(1 / true で付ける)
 *   ② リバースプロキシ(Nginx や Cloudflare など)越しなら x-forwarded-proto を見る
 *   ③ どちらも無ければ直結。Next.js 自身はTLSを終端しないので平文HTTPであり、付けない
 *
 *   HTTPSで公開するときは、プロキシが x-forwarded-proto を付けていれば②で自動的に
 *   有効になる。付けてくれないプロキシを使う場合だけ COOKIE_SECURE=1 を明示すること。
 */
function cookieSecure(): boolean {
  const flag = process.env.COOKIE_SECURE?.trim().toLowerCase();
  if (flag) return flag === "1" || flag === "true";
  const proto = headers().get("x-forwarded-proto");
  return proto ? proto.split(",")[0].trim() === "https" : false;
}

/**
 * ログインする。成功したらセッションを作ってCookieに入れる。
 * 失敗の理由は画面に出さない(「IDが違う」と「パスワードが違う」を区別すると、
 * 存在するIDを総当たりで特定できてしまうため)。
 */
export async function login(
  username: string,
  password: string,
  userAgent?: string
): Promise<{ ok: true; user: AppUser } | { ok: false; error: string }> {
  const sb = getSupabase();
  const row = must(
    await sb
      .from("app_users")
      .select(`${USER_COLUMNS}, password_hash`)
      .eq("username", username.trim())
      .maybeSingle()
  ) as (AppUser & { password_hash: string }) | null;

  // 利用者が存在しない場合もハッシュ計算を1回走らせて、応答時間を揃える
  const stored = row?.password_hash ?? (await hashPassword("dummy"));
  const okPassword = await verifyPassword(password, stored);

  if (!row || !okPassword) return { ok: false, error: "ログインIDまたはパスワードが違います。" };
  if (!row.is_active) return { ok: false, error: "このアカウントは停止されています。管理者にご連絡ください。" };

  const token = randomBytes(32).toString("base64url");
  must(
    await sb
      .from("app_sessions")
      .insert({ token, user_id: row.id, expires_at: expiryDate(), user_agent: userAgent ?? null })
      .select("token")
  );
  must(await sb.from("app_users").update({ last_login_at: new Date().toISOString() }).eq("id", row.id).select("id"));

  cookies().set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });

  const { password_hash: _drop, ...user } = row;
  return { ok: true, user };
}

/** ログアウトする。セッションを消してCookieも落とす */
export async function logout(): Promise<void> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (token) {
    await getSupabase().from("app_sessions").delete().eq("token", token);
  }
  cookies().delete(SESSION_COOKIE);
}

/**
 * いまログインしている利用者。ログインしていなければ null。
 *
 * middleware では Cookie があるかどうかしか見ていない(Edgeランタイムでは
 * DBを引く前提を置きたくないため)。**実際の検証はここで必ず行う**ので、
 * 画面とサーバーアクションは毎回この関数を通すこと。
 */
export async function currentUser(): Promise<AppUser | null> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const sb = getSupabase();
  const session = must(
    await sb.from("app_sessions").select("token, user_id, expires_at").eq("token", token).maybeSingle()
  ) as { token: string; user_id: number; expires_at: string } | null;
  if (!session) return null;

  // 期限切れは、その場で片付ける
  if (Date.parse(session.expires_at) < Date.now()) {
    await sb.from("app_sessions").delete().eq("token", token);
    return null;
  }

  const user = must(
    await sb.from("app_users").select(USER_COLUMNS).eq("id", session.user_id).maybeSingle()
  ) as AppUser | null;
  if (!user || !user.is_active) return null;
  return user;
}

/** ログイン必須。していなければ null を返すので、呼び出し側で redirect する */
export async function requireUser(): Promise<AppUser | null> {
  return await currentUser();
}

/** 管理者必須。管理者でなければ null */
export async function requireAdmin(): Promise<AppUser | null> {
  const user = await currentUser();
  return user?.role === "admin" ? user : null;
}

// ---------------------------------------------------------------- 利用者のCRUD

export async function listUsers(): Promise<AppUser[]> {
  const rows = must(
    await getSupabase().from("app_users").select(USER_COLUMNS).order("id", { ascending: true })
  ) as AppUser[] | null;
  return rows ?? [];
}

/** ログインIDとして使える形か。DBの一意制約より手前で弾いて、分かりやすく伝える */
export function validateUsername(username: string): string | null {
  const u = username.trim();
  if (u.length < 3) return "ログインIDは3文字以上にしてください。";
  if (u.length > 32) return "ログインIDは32文字までです。";
  if (!/^[A-Za-z0-9._-]+$/.test(u)) return "ログインIDに使えるのは英数字と . _ - です。";
  return null;
}

export function validatePassword(password: string): string | null {
  if (password.length < 8) return "パスワードは8文字以上にしてください。";
  if (password.length > 128) return "パスワードは128文字までです。";
  return null;
}

export type CreateUserInput = {
  username: string;
  password: string;
  role?: Role;
  display_name?: string | null;
  note?: string | null;
};

export async function createUser(
  input: CreateUserInput
): Promise<{ ok: true; user: AppUser } | { ok: false; error: string }> {
  const username = input.username.trim();
  const nameError = validateUsername(username);
  if (nameError) return { ok: false, error: nameError };
  // 既定の管理者と紛らわしいログインIDは作らせない(大小文字違いも含む)
  if (isFixedAdmin(username)) {
    return { ok: false, error: "このログインIDは既定の管理者用に予約されています。" };
  }
  const passError = validatePassword(input.password);
  if (passError) return { ok: false, error: passError };

  const sb = getSupabase();
  const dup = must(
    await sb.from("app_users").select("id").eq("username", username).maybeSingle()
  ) as { id: number } | null;
  if (dup) return { ok: false, error: `ログインID「${username}」はすでに使われています。` };

  const created = must(
    await sb
      .from("app_users")
      .insert({
        username,
        password_hash: await hashPassword(input.password),
        password_enc: encryptPassword(input.password),
        role: input.role ?? "member",
        display_name: input.display_name?.trim() || null,
        note: input.note?.trim() || null,
        is_active: true,
      })
      .select(USER_COLUMNS)
      .single()
  ) as AppUser;
  return { ok: true, user: created };
}

export type UpdateUserInput = {
  display_name?: string | null;
  note?: string | null;
  role?: Role;
  is_active?: boolean;
  /** 指定したときだけパスワードを変更する */
  password?: string;
};

export async function updateUser(
  id: number,
  patch: UpdateUserInput
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = getSupabase();
  const target = must(
    await sb.from("app_users").select("id, username, role").eq("id", id).maybeSingle()
  ) as { id: number; username: string; role: Role } | null;
  if (!target) return { ok: false, error: "その利用者は見つかりませんでした。" };

  // 既定の管理者は、資格情報・権限・有効状態を変更できない(表示名とメモだけ触れる)
  if (isFixedAdmin(target.username)) {
    if (patch.password !== undefined) {
      return { ok: false, error: "既定の管理者アカウントのパスワードは変更できません。" };
    }
    if (patch.role !== undefined && patch.role !== "admin") {
      return { ok: false, error: "既定の管理者アカウントの権限は変更できません。" };
    }
    if (patch.is_active === false) {
      return { ok: false, error: "既定の管理者アカウントは停止できません。" };
    }
  }

  const row: Record<string, unknown> = {};
  if (patch.display_name !== undefined) row.display_name = patch.display_name?.trim() || null;
  if (patch.note !== undefined) row.note = patch.note?.trim() || null;
  if (patch.role !== undefined) row.role = patch.role;
  if (patch.is_active !== undefined) row.is_active = patch.is_active;
  if (patch.password !== undefined) {
    const passError = validatePassword(patch.password);
    if (passError) return { ok: false, error: passError };
    row.password_hash = await hashPassword(patch.password);
    row.password_enc = encryptPassword(patch.password);
  }

  // 管理者が1人もいなくなる操作は止める(自分を降格/停止して締め出されるのを防ぐ)
  const losingAdmin =
    target.role === "admin" && ((patch.role !== undefined && patch.role !== "admin") || patch.is_active === false);
  if (losingAdmin && (await countActiveAdmins()) <= 1) {
    return { ok: false, error: "管理者が1人もいなくなるため、この変更はできません。" };
  }

  if (Object.keys(row).length === 0) return { ok: true };
  must(await sb.from("app_users").update(row).eq("id", id).select("id"));

  // パスワードを変えた/停止したら、その利用者の既存ログインを無効にする
  if (row.password_hash || patch.is_active === false) {
    await sb.from("app_sessions").delete().eq("user_id", id);
  }
  return { ok: true };
}

export async function deleteUser(id: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = getSupabase();
  const target = must(
    await sb.from("app_users").select("id, username, role").eq("id", id).maybeSingle()
  ) as { id: number; username: string; role: Role } | null;
  if (!target) return { ok: false, error: "その利用者は見つかりませんでした。" };
  if (isFixedAdmin(target.username)) {
    return { ok: false, error: "既定の管理者アカウントは削除できません。" };
  }
  if (target.role === "admin" && (await countActiveAdmins()) <= 1) {
    return { ok: false, error: "最後の管理者は削除できません。" };
  }
  // セッションは ON DELETE CASCADE で一緒に消えるが、明示的に消しておく
  await sb.from("app_sessions").delete().eq("user_id", id);
  must(await sb.from("app_users").delete().eq("id", id).select("id"));
  return { ok: true };
}

async function countActiveAdmins(): Promise<number> {
  const res = await getSupabase()
    .from("app_users")
    .select("id", { count: "exact", head: true })
    .eq("role", "admin")
    .eq("is_active", true);
  if (res.error) throw new Error(res.error.message);
  return res.count ?? 0;
}

/** その利用者のログインをすべて無効にする(共有された端末から締め出したいとき) */
export async function revokeSessions(id: number): Promise<void> {
  await getSupabase().from("app_sessions").delete().eq("user_id", id);
}

/** 期限切れのセッションを掃除する。ログイン画面を開いたついでに呼ぶ */
export async function purgeExpiredSessions(): Promise<void> {
  await getSupabase().from("app_sessions").delete().lt("expires_at", new Date().toISOString());
}

/** app_users テーブルがまだ無い(schema.sql 未適用)かどうか */
export function isMissingAuthTables(e: unknown): boolean {
  const s = String(e instanceof Error ? e.message : e);
  return /app_users|app_sessions/.test(s) && /does not exist|schema cache|42P01/i.test(s);
}
