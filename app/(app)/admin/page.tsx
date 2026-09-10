import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  createUser,
  deleteUser,
  ensureAdminUser,
  generatePassword,
  generateUsername,
  isFixedAdmin,
  isMissingAuthTables,
  listUsers,
  requireAdmin,
  revealUserPassword,
  revokeSessions,
  updateUser,
  type AppUser,
  type Role,
} from "../../../lib/auth";
import { IconAlert } from "../../icons";
import AdminClient from "./AdminClient";

export const dynamic = "force-dynamic";

export const metadata = { title: "会員管理 — 転売リサーチダッシュボード" };

/**
 * 発行した資格情報を、画面上部に出すための受け渡し。
 * 暗号化保存により、あとから鍵アイコンで再表示もできる。
 */
export type IssuedCredential = { username: string; password: string };

export type ActionResult = {
  ok?: string;
  error?: string;
  issued?: IssuedCredential;
  password?: string;
};

/** 管理者以外は触れない。すべてのアクションの先頭で確認する */
async function assertAdmin() {
  const admin = await requireAdmin();
  if (!admin) redirect("/login");
  return admin;
}

/** ランダムな資格情報で利用者を発行する */
async function issueUser(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  "use server";
  await assertAdmin();

  const note = String(formData.get("note") ?? "");
  const role = (String(formData.get("role") ?? "member") === "admin" ? "admin" : "member") as Role;

  // ログインIDが偶然ぶつかることがあるので、数回だけ作り直す
  for (let attempt = 0; attempt < 5; attempt++) {
    const username = generateUsername();
    const password = generatePassword();
    const res = await createUser({ username, password, role, note });
    if (res.ok) {
      revalidatePath("/admin");
      return { ok: `利用者「${username}」を発行しました。`, issued: { username, password } };
    }
    if (!res.error.includes("すでに使われています")) return { error: res.error };
  }
  return { error: "ログインIDの生成に繰り返し失敗しました。もう一度お試しください。" };
}

/** ログインIDとパスワードを指定して発行する */
async function addUser(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  "use server";
  await assertAdmin();

  const username = String(formData.get("username") ?? "");
  const password = String(formData.get("password") ?? "");
  const note = String(formData.get("note") ?? "");
  const role = (String(formData.get("role") ?? "member") === "admin" ? "admin" : "member") as Role;

  const res = await createUser({ username, password, role, note });
  if (!res.ok) return { error: res.error };
  revalidatePath("/admin");
  return { ok: `利用者「${username}」を発行しました。`, issued: { username, password } };
}

/** 表示名・メモ・権限・有効/停止を更新する */
async function editUser(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  "use server";
  await assertAdmin();

  const id = Number(formData.get("id"));
  const res = await updateUser(id, {
    display_name: String(formData.get("display_name") ?? ""),
    note: String(formData.get("note") ?? ""),
    role: (String(formData.get("role") ?? "member") === "admin" ? "admin" : "member") as Role,
    is_active: formData.get("is_active") === "on",
  });
  if (!res.ok) return { error: res.error };
  revalidatePath("/admin");
  return { ok: "変更を保存しました。" };
}

/** パスワードを変更する(指定があればその値、ランダム指定なら再発行) */
async function resetPassword(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  "use server";
  await assertAdmin();

  const id = Number(formData.get("id"));
  const username = String(formData.get("username") ?? "");
  const random = String(formData.get("mode") ?? "") === "random";
  const custom = random ? "" : String(formData.get("password") ?? "").trim();
  if (!random && !custom) {
    return { error: "新しいパスワードを入力するか、「ランダム再発行」を押してください。" };
  }
  const password = custom || generatePassword();
  const res = await updateUser(id, { password });
  if (!res.ok) return { error: res.error };
  revalidatePath("/admin");
  return {
    ok: custom
      ? `「${username}」のパスワードを変更しました。`
      : `「${username}」のパスワードを再発行しました。`,
    issued: { username, password },
  };
}

/** 保存済みパスワードを管理者に見せる */
async function revealPassword(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  "use server";
  await assertAdmin();
  const id = Number(formData.get("id"));
  const res = await revealUserPassword(id);
  if (!res.ok) return { error: res.error };
  return { password: res.password };
}

/** その利用者のログインをすべて無効にする */
async function signOutUser(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  "use server";
  await assertAdmin();
  const id = Number(formData.get("id"));
  await revokeSessions(id);
  revalidatePath("/admin");
  return { ok: "この利用者のログイン状態を解除しました。" };
}

/** 利用者を削除する */
async function removeUser(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  "use server";
  const admin = await assertAdmin();
  const id = Number(formData.get("id"));
  if (id === admin.id) return { error: "自分自身は削除できません。" };
  const res = await deleteUser(id);
  if (!res.ok) return { error: res.error };
  revalidatePath("/admin");
  return { ok: "利用者を削除しました。" };
}

export default async function AdminPage() {
  const admin = await requireAdmin();
  if (!admin) redirect("/login");

  let users: AppUser[] = [];
  let error: string | null = null;
  try {
    // 既定の管理者が消えていたり書き換えられていたら、ここで元に戻す
    await ensureAdminUser();
    users = await listUsers();
  } catch (e) {
    error = isMissingAuthTables(e)
      ? "利用者テーブルがまだ作られていません。supabase/schema.sql を Supabase の SQL Editor に貼って Run してください。"
      : String(e).slice(0, 200);
  }

  return (
    <div className="page page-wide">
      <div className="page-head">
        <p className="page-desc">
          ログインIDは<strong>ここでしか発行できません</strong>(利用者が自分で登録することはできません)。
          パスワードは鍵アイコンから確認・変更できます。発行直後も上部パネルに表示されます。
        </p>
      </div>

      {error && (
        <div className="note note-error">
          <IconAlert size={15} />
          <span>{error}</span>
        </div>
      )}

      <AdminClient
        users={users}
        currentAdminId={admin.id}
        fixedAdminId={users.find((u) => isFixedAdmin(u.username))?.id ?? null}
        actions={{ issueUser, addUser, editUser, resetPassword, revealPassword, signOutUser, removeUser }}
      />
    </div>
  );
}
