/**
 * DBスキーマ(supabase/schema.sql)がまだ適用されていないときの案内。
 *
 * 後から足した列が無いDBでも画面自体は出るようにしてあるが、
 * アバター・セラー分類・実送料の取得状況などは空欄になる。
 * 生のPostgRESTエラーを出すより、何をすれば直るかを書いたほうがよい。
 */
import { IconAlert } from "./icons";

export default function MigrationNotice({ what }: { what?: string }) {
  return (
    <div className="note note-info">
      <IconAlert size={15} />
      <span>
        <strong>DBの更新がまだ適用されていません。</strong>
        {what ? `${what}が表示されません。` : "一部の項目が表示されません。"}
        <br />
        <code>supabase/schema.sql</code> を Supabase ダッシュボード &gt; SQL Editor に貼って Run
        してください(<code>npm run db:push</code> でも適用できます)。適用状況は{" "}
        <code>npm run db:check</code> で確認できます。
      </span>
    </div>
  );
}
