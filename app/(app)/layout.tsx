import { redirect } from "next/navigation";
import { currentUser, isMissingAuthTables, logout } from "../../lib/auth";
import { getSupabase } from "../../lib/db";
import AppHeader, { type Counts } from "../AppHeader";
import Nav from "../Nav";

/**
 * ログインが要る画面すべての枠。
 *
 * **ここが唯一の関門**。middleware はCookieの有無しか見ていないので、
 * セッションが本物かどうかの確認はここで行う。このレイアウトの下に置いた画面は
 * 必ずこの確認を通るため、画面ごとに書き忘れる余地が無い。
 *
 * 画面の作り:
 *   左に固定のサイドバー(①②③の順路)、上に固定のヘッダー(画面名と件数)、
 *   本文だけが縦に流れる。一覧が長くなっても現在地を見失わないようにするため。
 */
export const dynamic = "force-dynamic";

async function signOut() {
  "use server";
  await logout();
  redirect("/login");
}

/**
 * ヘッダーに出す件数を数える。
 *
 * 行は運ばず件数だけを受け取る(`head: true`)ので、どれだけ溜まっていても速い。
 * ここが失敗しても画面は出す — 件数は補助情報であって、
 * 数えられないことを理由に本文を出さない方が困る。
 */
async function getCounts(): Promise<Counts> {
  try {
    const db = getSupabase();
    const [searches, deepdive, running] = await Promise.all([
      db.from("searches").select("id", { count: "exact", head: true }),
      db.from("deepdive_items").select("id", { count: "exact", head: true }).neq("status", "rejected"),
      db.from("jobs").select("id", { count: "exact", head: true }).in("status", ["queued", "running"]),
    ]);
    return {
      searches: searches.count ?? 0,
      deepdive: deepdive.count ?? 0,
      running: running.count ?? 0,
    };
  } catch {
    return null;
  }
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

  const counts = await getCounts();
  const name = user.display_name || user.username;

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
          <div className="side-user">
            <span className="avatar-sq" aria-hidden="true">
              {name.slice(0, 1).toUpperCase()}
            </span>
            <span className="user-meta">
              <span className="side-name" title={user.username}>
                {name}
              </span>
              <i className={`acct-status${user.role === "admin" ? " admin" : ""}`}>
                {user.role === "admin" ? "✓ 管理者アカウント" : "✓ アカウント有効"}
              </i>
            </span>
            <form action={signOut}>
              <button type="submit" className="side-logout">
                ログアウト
              </button>
            </form>
          </div>
        </div>
      </aside>

      <main className="main">
        <AppHeader counts={counts} />
        <div className="app-scroll">
          <div className="app-content">{children}</div>
        </div>
      </main>
    </div>
  );
}
