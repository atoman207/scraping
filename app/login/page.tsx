import { redirect } from "next/navigation";
import { headers } from "next/headers";
import {
  currentUser,
  ensureAdminUser,
  isMissingAuthTables,
  login as doLogin,
  purgeExpiredSessions,
} from "../../lib/auth";
import { IconAlert, IconLock } from "../icons";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

export const metadata = { title: "ログイン — 転売リサーチダッシュボード" };

/** 戻り先が外部URLに書き換えられないよう、サイト内の絶対パスだけ許す */
function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/";
  return next;
}

async function signIn(_prev: { error?: string } | null, formData: FormData) {
  "use server";
  const username = String(formData.get("username") ?? "");
  const password = String(formData.get("password") ?? "");
  const next = safeNext(String(formData.get("next") ?? ""));
  if (!username || !password) return { error: "ログインIDとパスワードを入力してください。" };

  const ua = headers().get("user-agent") ?? undefined;
  let res: Awaited<ReturnType<typeof doLogin>>;
  try {
    res = await doLogin(username, password, ua);
  } catch (e) {
    if (isMissingAuthTables(e)) {
      return { error: "利用者テーブルがまだ作られていません。supabase/schema.sql を適用してください。" };
    }
    return { error: `ログインできませんでした: ${String(e).slice(0, 160)}` };
  }
  if (!res.ok) return { error: res.error };
  redirect(next);
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: { next?: string };
}) {
  // すでにログイン済みなら、そのまま中へ
  let setupError: string | null = null;
  try {
    const user = await currentUser();
    if (user) redirect(safeNext(searchParams.next));
    // 既定の管理者を用意する(いなければ作り、ずれていれば戻す)。
    // 資格情報はこの画面には**一切表示しない**。
    await ensureAdminUser();
    await purgeExpiredSessions();
  } catch (e) {
    // redirect() は例外で制御を移すので、そのまま投げ直す
    if (e && typeof e === "object" && "digest" in e) throw e;
    setupError = isMissingAuthTables(e)
      ? "利用者テーブルがまだ作られていません。supabase/schema.sql を Supabase の SQL Editor に貼って Run してください。"
      : String(e).slice(0, 200);
  }

  return (
    <div className="auth-shell">
      <div className="auth-card fade-up">
        <div className="auth-brand">
          <img src="/logo.png" alt="" width={64} height={64} />
          <b>転売リサーチ</b>
        </div>
        <p className="auth-desc" style={{ marginBottom: 20 }}>
          メルカリで繰り返し売れている鉄板商品を見つけ、仕入れの採算まで計算するリサーチツールです。
        </p>
        <h1 className="auth-title">
          <IconLock size={15} />
          会員ログイン
        </h1>

        {setupError && (
          <div className="note note-error" style={{ marginBottom: 14 }}>
            <IconAlert size={15} />
            <span>{setupError}</span>
          </div>
        )}

        <LoginForm action={signIn} next={safeNext(searchParams.next)} />

        <p className="auth-foot">
          アカウントは管理者が発行します。ご自身での登録はできません。
          うまくいかないときは管理者へご連絡ください。
        </p>
      </div>
    </div>
  );
}
