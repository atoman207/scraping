"use client";

/**
 * 会員管理の操作部分。
 *
 * 実際の読み書きはサーバーアクション(app/(app)/admin/page.tsx)で行い、
 * ここは入力と表示だけを受け持つ。管理者かどうかの確認はサーバー側で毎回するので、
 * この画面を無理に開かれても操作は通らない。
 */
import { useFormState, useFormStatus } from "react-dom";
import { useEffect, useState } from "react";
import type { AppUser } from "../../../lib/auth";
import {
  IconAlert,
  IconCheck,
  IconCopy,
  IconDice,
  IconEdit,
  IconEye,
  IconEyeOff,
  IconKey,
  IconLoader,
  IconLock,
  IconLogout,
  IconShield,
  IconTrash,
  IconUser,
  IconUserPlus,
  IconX,
} from "../../icons";

type IssuedCredential = { username: string; password: string };
type ActionResult = { ok?: string; error?: string; issued?: IssuedCredential; password?: string };
type Action = (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;

type Props = {
  users: AppUser[];
  currentAdminId: number;
  /** 既定の管理者のid。この利用者は資格情報・権限・状態を変更できない */
  fixedAdminId: number | null;
  actions: {
    issueUser: Action;
    addUser: Action;
    editUser: Action;
    resetPassword: Action;
    revealPassword: Action;
    signOutUser: Action;
    removeUser: Action;
  };
};

/** 送信中の状態をボタンに出す。サーバーアクションの進行はこれでしか分からない */
function Submit({
  children,
  className = "btn btn-primary",
  busyLabel,
  confirm,
  title,
  name,
  value,
  formNoValidate,
  "aria-label": ariaLabel,
}: {
  children: React.ReactNode;
  className?: string;
  busyLabel?: string;
  /** 押す前に確認を取る文言(削除など、取り消せない操作) */
  confirm?: string;
  title?: string;
  name?: string;
  value?: string;
  formNoValidate?: boolean;
  "aria-label"?: string;
}) {
  const { pending } = useFormStatus();
  const iconOnly = className.includes("btn-icon");
  return (
    <button
      type="submit"
      className={className}
      disabled={pending}
      data-busy={pending || undefined}
      title={title}
      name={name}
      value={value}
      formNoValidate={formNoValidate}
      aria-label={ariaLabel ?? title}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {pending ? (
        <>
          <IconLoader size={13} className="spin" />
          {!iconOnly && (busyLabel ?? "処理中")}
        </>
      ) : (
        children
      )}
    </button>
  );
}

/** 発行した資格情報。画面を離れると二度と見られないので、その旨を明記する */
function IssuedPanel({ cred, onClose }: { cred: IssuedCredential; onClose: () => void }) {
  const [copied, setCopied] = useState<"" | "user" | "pass" | "both">("");

  const copy = async (text: string, what: typeof copied) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(""), 1800);
    } catch {
      /* クリップボードが使えない環境では、手で選択してもらう */
    }
  };

  return (
    <div className="cred-panel fade-up">
      <div className="cred-head">
        <IconKey size={15} />
        資格情報 — この内容が見られるのは<strong>今だけ</strong>です
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} style={{ marginLeft: "auto" }}>
          <IconX size={12} />
          閉じる
        </button>
      </div>
      <div className="cred-grid">
        <div className="cred-item">
          <div className="cred-label">ログインID</div>
          <code className="cred-value">{cred.username}</code>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(cred.username, "user")}>
            {copied === "user" ? <IconCheck size={12} /> : <IconCopy size={12} />}
            {copied === "user" ? "コピー済" : "コピー"}
          </button>
        </div>
        <div className="cred-item">
          <div className="cred-label">パスワード</div>
          <code className="cred-value">{cred.password}</code>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(cred.password, "pass")}>
            {copied === "pass" ? <IconCheck size={12} /> : <IconCopy size={12} />}
            {copied === "pass" ? "コピー済" : "コピー"}
          </button>
        </div>
      </div>
      <button
        type="button"
        className="btn btn-dark btn-sm"
        onClick={() => copy(`ログインID: ${cred.username}\nパスワード: ${cred.password}`, "both")}
      >
        {copied === "both" ? <IconCheck size={12} /> : <IconCopy size={12} />}
        {copied === "both" ? "両方コピーしました" : "両方まとめてコピー"}
      </button>
      <p className="hint" style={{ marginTop: 8 }}>
        この内容は鍵アイコンからいつでも再表示できます。控えて本人にお渡しください。
      </p>
    </div>
  );
}

/** 画面中央のモーダル。背景クリック / Esc で閉じる */
function Modal({
  title,
  icon,
  onClose,
  children,
  wide,
}: {
  title: string;
  icon?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div className="modal-root" role="presentation">
      <button type="button" className="modal-backdrop" aria-label="閉じる" onClick={onClose} />
      <div
        className={`modal-dialog fade-up${wide ? " modal-dialog-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-head">
          <div className="modal-title">
            {icon}
            {title}
          </div>
          <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={onClose} title="閉じる" aria-label="閉じる">
            <IconX size={14} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/** パスワード確認・変更(モーダル内) */
function PasswordModalBody({
  userId,
  username,
  formAction,
  revealAction,
  onCancel,
}: {
  userId: number;
  username: string;
  formAction: (payload: FormData) => void;
  revealAction: Action;
  onCancel: () => void;
}) {
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [copied, setCopied] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setCurrent(null);
    setRevealError(null);
    setShowCurrent(false);
    (async () => {
      const fd = new FormData();
      fd.set("id", String(userId));
      const res = await revealAction(null, fd);
      if (cancelled) return;
      if (res?.password) setCurrent(res.password);
      else setRevealError(res?.error ?? "パスワードを取得できませんでした。");
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const copy = async () => {
    if (!current) return;
    try {
      await navigator.clipboard.writeText(current);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* 手で選択してもらう */
    }
  };

  return (
    <>
      <div className="modal-stack">
        <label className="field">
          現在のパスワード
          <span className="input-icon">
            <input
              className="input input-wide"
              type={showCurrent ? "text" : "password"}
              readOnly
              value={current ?? ""}
              placeholder={loading ? "読み込み中…" : revealError ?? ""}
              style={{ paddingLeft: 10 }}
            />
            <button
              type="button"
              className="input-toggle"
              disabled={!current}
              onClick={() => setShowCurrent((v) => !v)}
              aria-label={showCurrent ? "パスワードを隠す" : "パスワードを表示"}
              title={showCurrent ? "パスワードを隠す" : "パスワードを表示"}
            >
              {showCurrent ? <IconEyeOff size={14} /> : <IconEye size={14} />}
            </button>
          </span>
        </label>
        <button type="button" className="btn btn-ghost btn-sm" disabled={!current} onClick={copy} title="コピー">
          {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
          {copied ? "コピー済" : "コピー"}
        </button>
      </div>
      {revealError && !current && !loading && (
        <p className="hint" style={{ margin: "0 0 12px" }}>
          <IconLock size={12} style={{ marginRight: 4, verticalAlign: -1 }} />
          {revealError}
        </p>
      )}

      <form action={formAction} className="modal-form">
        <input type="hidden" name="id" value={userId} />
        <input type="hidden" name="username" value={username} />
        <label className="field">
          新しいパスワード
          <span className="input-icon">
            <input
              className="input input-wide"
              name="password"
              type={showNew ? "text" : "password"}
              minLength={8}
              required
              autoComplete="new-password"
              placeholder="8文字以上"
              style={{ paddingLeft: 10 }}
            />
            <button
              type="button"
              className="input-toggle"
              onClick={() => setShowNew((v) => !v)}
              aria-label={showNew ? "パスワードを隠す" : "パスワードを表示"}
              title={showNew ? "パスワードを隠す" : "パスワードを表示"}
            >
              {showNew ? <IconEyeOff size={14} /> : <IconEye size={14} />}
            </button>
          </span>
        </label>
        <div className="modal-actions">
          <Submit className="btn btn-primary btn-sm" busyLabel="変更中">
            <IconKey size={12} />
            変更する
          </Submit>
          <Submit className="btn btn-ghost btn-sm" name="mode" value="random" formNoValidate busyLabel="発行中">
            <IconDice size={12} />
            ランダム再発行
          </Submit>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
            取消
          </button>
        </div>
      </form>
    </>
  );
}

/** サーバーアクションの結果(成功/失敗メッセージ)をまとめて出す */
function Result({ state }: { state: ActionResult | null }) {
  if (!state?.ok && !state?.error) return null;
  return (
    <div className={`note ${state.error ? "note-error" : "note-ok"}`} style={{ marginTop: 12, marginBottom: 0 }}>
      {state.error ? <IconAlert size={15} /> : <IconCheck size={15} />}
      <span>{state.error ?? state.ok}</span>
    </div>
  );
}

type ModalKind = "edit" | "password" | "revoke" | "remove";
type ModalState = { kind: ModalKind; userId: number };

export default function AdminClient({ users, currentAdminId, fixedAdminId, actions }: Props) {
  const [issueState, issueAction] = useFormState(actions.issueUser, null);
  const [addState, addAction] = useFormState(actions.addUser, null);
  const [resetState, resetAction] = useFormState(actions.resetPassword, null);
  const [editState, editAction] = useFormState(actions.editUser, null);
  const [revokeState, revokeAction] = useFormState(actions.signOutUser, null);
  const [removeState, removeAction] = useFormState(actions.removeUser, null);

  const [mode, setMode] = useState<"random" | "manual">("random");
  const [modal, setModal] = useState<ModalState | null>(null);
  const [cred, setCred] = useState<IssuedCredential | null>(null);

  const closeModal = () => setModal(null);
  const activeUser = modal ? users.find((u) => u.id === modal.userId) ?? null : null;
  const activeLocked = activeUser ? activeUser.id === fixedAdminId : false;

  // 発行・再発行が成功したら、その資格情報を上部に出す
  useEffect(() => {
    if (issueState?.issued) setCred(issueState.issued);
  }, [issueState]);
  useEffect(() => {
    if (addState?.issued) setCred(addState.issued);
  }, [addState]);
  useEffect(() => {
    if (resetState?.issued) {
      setCred(resetState.issued);
      setModal(null);
    }
  }, [resetState]);
  useEffect(() => {
    if (editState?.ok) setModal(null);
  }, [editState]);
  useEffect(() => {
    if (revokeState?.ok) setModal(null);
  }, [revokeState]);
  useEffect(() => {
    if (removeState?.ok) setModal(null);
  }, [removeState]);

  return (
    <>
      {cred && <IssuedPanel cred={cred} onClose={() => setCred(null)} />}

      {/* ---------------------------------------------------- 発行 */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="runner-head" style={{ marginBottom: 10 }}>
          <IconUserPlus size={15} style={{ color: "var(--brand)" }} />
          利用者を発行する
        </div>

        <div className="seg" role="tablist">
          <button
            type="button"
            className="seg-btn"
            data-active={mode === "random"}
            onClick={() => setMode("random")}
          >
            <IconDice size={13} />
            ランダムに発行
          </button>
          <button
            type="button"
            className="seg-btn"
            data-active={mode === "manual"}
            onClick={() => setMode("manual")}
          >
            <IconEdit size={13} />
            指定して発行
          </button>
        </div>

        {mode === "random" ? (
          <form action={issueAction}>
            <p className="hint" style={{ margin: "10px 0" }}>
              ログインIDとパスワードを自動で作ります。紛らわしい文字(0とO、1とlなど)は使いません。
            </p>
            <div className="form-row">
              <label className="field" style={{ flex: 1, minWidth: 220 }}>
                メモ(任意・誰に渡すか)
                <input className="input input-wide" name="note" placeholder="例: 山田さん用" />
              </label>
              <label className="field">
                権限
                <select className="input" name="role" style={{ width: 130 }} defaultValue="member">
                  <option value="member">一般</option>
                  <option value="admin">管理者</option>
                </select>
              </label>
              <Submit busyLabel="発行中">
                <IconDice size={14} />
                ランダムに発行
              </Submit>
            </div>
            <Result state={issueState} />
          </form>
        ) : (
          <form action={addAction}>
            <p className="hint" style={{ margin: "10px 0" }}>
              ログインIDは英数字と <code>. _ -</code> で3〜32文字。パスワードは8文字以上。
            </p>
            <div className="form-row">
              <label className="field" style={{ minWidth: 180 }}>
                ログインID
                <input
                  className="input input-wide"
                  name="username"
                  required
                  autoCapitalize="off"
                  spellCheck={false}
                  placeholder="例: yamada"
                />
              </label>
              <label className="field" style={{ minWidth: 180 }}>
                パスワード
                <input className="input input-wide" name="password" required minLength={8} placeholder="8文字以上" />
              </label>
              <label className="field" style={{ flex: 1, minWidth: 160 }}>
                メモ(任意)
                <input className="input input-wide" name="note" placeholder="例: 山田さん用" />
              </label>
              <label className="field">
                権限
                <select className="input" name="role" style={{ width: 130 }} defaultValue="member">
                  <option value="member">一般</option>
                  <option value="admin">管理者</option>
                </select>
              </label>
              <Submit busyLabel="発行中">
                <IconUserPlus size={14} />
                発行
              </Submit>
            </div>
            <Result state={addState} />
          </form>
        )}
      </div>

      {/* ---------------------------------------------------- 一覧 */}
      <Result state={removeState} />
      <Result state={revokeState} />
      <Result state={resetState} />
      <Result state={editState} />

      <div className="table-wrap" style={{ marginTop: 12 }}>
        <table className="data">
          <thead>
            <tr>
              <th>利用者</th>
              <th className="tight">権限</th>
              <th className="tight">状態</th>
              <th className="tight">最終ログイン</th>
              <th className="tight right actions-col">操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const locked = u.id === fixedAdminId;
              return (
                <tr key={u.id} data-ng={!u.is_active}>
                  <td>
                    <div className="seller-cell">
                      <span className="avatar avatar-sm" data-hue={u.role === "admin" ? 0 : 2} aria-hidden="true">
                        {u.role === "admin" ? <IconShield size={12} /> : <IconUser size={12} />}
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <div className="name">
                          {u.display_name || u.username}
                          {u.id === currentAdminId && (
                            <span className="pill pill-brand" style={{ marginLeft: 6 }}>
                              自分
                            </span>
                          )}
                          {locked && (
                            <span className="pill pill-mute" style={{ marginLeft: 6 }}>
                              既定(変更不可)
                            </span>
                          )}
                        </div>
                        <div className="sub">
                          <code>{u.username}</code>
                          {u.note && ` ・ ${u.note}`}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="tight">
                    <span className={`pill ${u.role === "admin" ? "pill-brand" : "pill-mute"}`}>
                      {u.role === "admin" ? "管理者" : "一般"}
                    </span>
                  </td>
                  <td className="tight">
                    <span className={`pill ${u.is_active ? "pill-good" : "pill-warn"}`}>
                      {u.is_active ? "有効" : "停止中"}
                    </span>
                  </td>
                  <td className="tight hint num">
                    {u.last_login_at ? u.last_login_at.slice(0, 16).replace("T", " ") : "未ログイン"}
                  </td>
                  <td className="tight right actions-col">
                    <div className="row-actions">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm btn-icon"
                        title="編集"
                        aria-label="編集"
                        onClick={() => setModal({ kind: "edit", userId: u.id })}
                      >
                        <IconEdit size={14} />
                      </button>
                      {!locked && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm btn-icon"
                          title="パスワードを表示・変更"
                          aria-label="パスワードを表示・変更"
                          onClick={() => setModal({ kind: "password", userId: u.id })}
                        >
                          <IconKey size={14} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm btn-icon"
                        title="ログイン解除"
                        aria-label="ログイン解除"
                        onClick={() => setModal({ kind: "revoke", userId: u.id })}
                      >
                        <IconLogout size={14} />
                      </button>
                      {u.id !== currentAdminId && !locked && (
                        <button
                          type="button"
                          className="btn btn-danger btn-sm btn-icon"
                          title="削除"
                          aria-label="削除"
                          onClick={() => setModal({ kind: "remove", userId: u.id })}
                        >
                          <IconTrash size={14} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {modal && activeUser && (
        <Modal
          title={
            modal.kind === "edit"
              ? `編集 — ${activeUser.display_name || activeUser.username}`
              : modal.kind === "password"
                ? `パスワード — ${activeUser.username}`
                : modal.kind === "revoke"
                  ? "ログイン解除"
                  : "利用者を削除"
          }
          icon={
            modal.kind === "edit" ? (
              <IconEdit size={15} />
            ) : modal.kind === "password" ? (
              <IconKey size={15} />
            ) : modal.kind === "revoke" ? (
              <IconLogout size={15} />
            ) : (
              <IconTrash size={15} />
            )
          }
          onClose={closeModal}
          wide={modal.kind === "edit" || modal.kind === "password"}
        >
          {modal.kind === "edit" && (
            <form action={editAction} className="modal-form">
              <input type="hidden" name="id" value={activeUser.id} />
              <label className="field">
                表示名
                <input
                  className="input input-wide"
                  name="display_name"
                  defaultValue={activeUser.display_name ?? ""}
                  placeholder="例: 山田"
                />
              </label>
              <label className="field">
                メモ
                <input className="input input-wide" name="note" defaultValue={activeUser.note ?? ""} />
              </label>
              {activeLocked ? (
                <>
                  <input type="hidden" name="role" value="admin" />
                  <input type="hidden" name="is_active" value="on" />
                  <p className="hint" style={{ margin: 0 }}>
                    権限: 管理者(固定)
                  </p>
                </>
              ) : (
                <div className="modal-stack">
                  <label className="field" style={{ flex: 1 }}>
                    権限
                    <select className="input input-wide" name="role" defaultValue={activeUser.role}>
                      <option value="member">一般</option>
                      <option value="admin">管理者</option>
                    </select>
                  </label>
                  <label className="check" style={{ paddingBottom: 0, alignSelf: "flex-end", marginBottom: 8 }}>
                    <input type="checkbox" name="is_active" defaultChecked={activeUser.is_active} />
                    有効
                  </label>
                </div>
              )}
              <div className="modal-actions">
                <Submit className="btn btn-primary btn-sm" busyLabel="保存中">
                  <IconCheck size={12} />
                  保存
                </Submit>
                <button type="button" className="btn btn-ghost btn-sm" onClick={closeModal}>
                  取消
                </button>
              </div>
            </form>
          )}

          {modal.kind === "password" && !activeLocked && (
            <PasswordModalBody
              userId={activeUser.id}
              username={activeUser.username}
              formAction={resetAction}
              revealAction={actions.revealPassword}
              onCancel={closeModal}
            />
          )}

          {modal.kind === "revoke" && (
            <form action={revokeAction} className="modal-form">
              <input type="hidden" name="id" value={activeUser.id} />
              <p className="modal-message">
                「<strong>{activeUser.username}</strong>」のログイン状態をすべて解除します。
                この利用者が開いている画面は、次回の操作でログアウト扱いになります。
              </p>
              <div className="modal-actions">
                <Submit className="btn btn-primary btn-sm" busyLabel="解除中">
                  <IconLogout size={12} />
                  解除する
                </Submit>
                <button type="button" className="btn btn-ghost btn-sm" onClick={closeModal}>
                  取消
                </button>
              </div>
            </form>
          )}

          {modal.kind === "remove" && (
            <form action={removeAction} className="modal-form">
              <input type="hidden" name="id" value={activeUser.id} />
              <p className="modal-message">
                利用者「<strong>{activeUser.username}</strong>」を削除します。
                この操作は元に戻せません。
              </p>
              <div className="modal-actions">
                <Submit className="btn btn-danger btn-sm" busyLabel="削除中">
                  <IconTrash size={12} />
                  削除する
                </Submit>
                <button type="button" className="btn btn-ghost btn-sm" onClick={closeModal}>
                  取消
                </button>
              </div>
            </form>
          )}
        </Modal>
      )}

      <p className="hint" style={{ marginTop: 14, display: "flex", alignItems: "flex-start", gap: 6 }}>
        <IconLock size={12} style={{ marginTop: 2, flexShrink: 0 }} />
        <span>
          パスワードはログイン検証用にハッシュ化し、管理者確認用に暗号化して保存しています。
          鍵アイコンから現在のパスワードを表示・変更できます。
          停止・削除・パスワード変更を行うと、その利用者のログイン状態はその場で無効になります。
          管理者が1人もいなくなる操作(最後の管理者の削除・降格・停止)はできません。
          既定の管理者アカウントは、パスワード・権限・有効状態・削除のいずれも変更できません
          (表示名とメモだけ編集できます)。
        </span>
      </p>
    </>
  );
}
