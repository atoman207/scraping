import { redirect } from "next/navigation";
import { currentUser, isMissingAuthTables, logout } from "../../lib/auth";
import Nav from "../Nav";
import { IconLogout, IconShield, IconUser } from "../icons";

/**
 * ログインが要る画面すべての枠。
 *
 * **ここが唯一の関門**。middleware はCookieの有無しか見ていないので、
 * セッションが本物かどうかの確認はここで行う。このレイアウトの下に置いた画面は
 * 必ずこの確認を通るため、画面ごとに書き忘れる余地が無い。
 */
export const dynamic = "force-dynamic";

async function signOut() {
  "use server";
  await logout();
  redirect("/login");
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  let user = null;
  try {
    user = await currentUser();
  } catch (e) {
    // 利用者テーブルがまだ無い場合もログイン画面へ送る(そこで案内を出す)
    if (!isMissingAuthTables(e)) throw e;
  }
  if (!user) redirect("/login");

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <img src="/logo.png" alt="" width={28} height={28} />
          </span>
          転売リサーチ
        </div>
        <Nav isAdmin={user.role === "admin"} />

        <div className="sidebar-foot">
          <div className="who">
            <span className="who-icon">
              {user.role === "admin" ? <IconShield size={13} /> : <IconUser size={13} />}
            </span>
            <span className="who-name" title={user.username}>
              {user.display_name || user.username}
            </span>
            {user.role === "admin" && <span className="pill pill-brand">管理者</span>}
          </div>
          <form action={signOut}>
            <button type="submit" className="btn btn-ghost btn-sm btn-block">
              <IconLogout size={13} />
              ログアウト
            </button>
          </form>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
