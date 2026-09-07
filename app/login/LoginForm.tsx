"use client";

/**
 * ログインフォーム。
 *
 * 送信中はボタンを押せなくして、二重送信で余計なセッションが増えないようにする。
 * パスワードは目のアイコンで一時的に表示できる(入力ミスの切り分け用)。
 */
import { useFormState, useFormStatus } from "react-dom";
import { useState } from "react";
import { IconAlert, IconArrowRight, IconEye, IconEyeOff, IconLoader, IconUser } from "../icons";

type State = { error?: string } | null;

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="btn btn-primary btn-block"
      disabled={pending}
      data-busy={pending || undefined}
    >
      {pending ? <IconLoader size={14} className="spin" /> : <IconArrowRight size={14} />}
      {pending ? "確認しています" : "ログイン"}
    </button>
  );
}

export default function LoginForm({
  action,
  next,
}: {
  action: (prev: State, formData: FormData) => Promise<State>;
  next: string;
}) {
  const [state, formAction] = useFormState(action, null);
  const [show, setShow] = useState(false);

  return (
    <form action={formAction} className="auth-form">
      <input type="hidden" name="next" value={next} />

      <label className="field">
        ログインID
        <span className="input-icon">
          <IconUser size={14} />
          <input
            className="input input-wide"
            name="username"
            autoComplete="username"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            required
            autoFocus
            placeholder="管理者から渡されたID"
          />
        </span>
      </label>

      <label className="field">
        パスワード
        <span className="input-icon">
          <input
            className="input input-wide"
            name="password"
            type={show ? "text" : "password"}
            autoComplete="current-password"
            required
            placeholder="管理者から渡されたパスワード"
            style={{ paddingLeft: 10 }}
          />
          <button
            type="button"
            className="input-toggle"
            onClick={() => setShow((v) => !v)}
            aria-label={show ? "パスワードを隠す" : "パスワードを表示"}
            title={show ? "パスワードを隠す" : "パスワードを表示"}
          >
            {show ? <IconEyeOff size={14} /> : <IconEye size={14} />}
          </button>
        </span>
      </label>

      {state?.error && (
        <div className="note note-error" style={{ margin: 0 }}>
          <IconAlert size={15} />
          <span>{state.error}</span>
        </div>
      )}

      <SubmitButton />
    </form>
  );
}
