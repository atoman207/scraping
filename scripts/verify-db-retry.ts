/**
 * Supabaseへの通信をやり直す条件を確かめる。
 *   npm run test:retry
 *
 * ネットワークにもDBにも触らない。global の fetch を差し替えて、
 * 決めた順番で応答を返し、「何回呼ばれたか」だけを見る。
 *
 * ここで守りたいのは2つ:
 *   ・一瞬の失敗で画面が500にならないこと(currentUser は全画面で呼ばれる)
 *   ・やり直しで**書き込みが二重に適用されないこと**
 */
import "./_env";
import { getSupabase } from "../lib/supabase";

let pass = 0;
let fail = 0;

function ok(label: string, cond: boolean, detail?: string) {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? "OK" : "NG"}   ${label}`);
  if (detail && !cond) console.log(`       ${detail}`);
}

const realFetch = globalThis.fetch;

/** 決めた応答を順に返す偽のfetch。呼ばれた回数を数える */
function stub(responses: Array<() => Response>) {
  let calls = 0;
  globalThis.fetch = (async () => {
    const make = responses[Math.min(calls, responses.length - 1)];
    calls++;
    return make();
  }) as typeof fetch;
  return () => calls;
}

const json = (body: string, status: number) =>
  new Response(body, { status, headers: { "Content-Type": "application/json" } });

const clockSkew = () => json(JSON.stringify({ message: "JWT issued at future" }), 401);
const serverError = () => json(JSON.stringify({ message: "upstream boom" }), 503);
const notFound = () => json(JSON.stringify({ message: "Could not find the table 'nope'" }), 404);
const success = () => json("[]", 200);

async function main() {
  console.log("\n===== Supabase 通信のやり直し条件 =====\n");
  const sb = getSupabase();

  // ① 読み取り中に時刻ズレで弾かれた → やり直して成功する
  {
    const calls = stub([clockSkew, clockSkew, success]);
    const res = await sb.from("app_users").select("id").limit(1);
    ok("読み取り: 時刻ズレは、やり直して回復する", !res.error && calls() === 3, `calls=${calls()} error=${res.error?.message}`);
  }

  // ② 書き込み中の時刻ズレ → 認証で弾かれておりDBに届いていないので、やり直してよい
  {
    const calls = stub([clockSkew, success]);
    const res = await sb.from("app_sessions").delete().eq("token", "dummy-not-real");
    ok("書き込み: 時刻ズレは、やり直して回復する", !res.error && calls() === 2, `calls=${calls()} error=${res.error?.message}`);
  }

  // ③ 読み取り中のサーバー不調 → 読み取りは何度でも同じなのでやり直す
  {
    const calls = stub([serverError, success]);
    const res = await sb.from("app_users").select("id").limit(1);
    ok("読み取り: 5xx は、やり直して回復する", !res.error && calls() === 2, `calls=${calls()} error=${res.error?.message}`);
  }

  // ④ 書き込み中のサーバー不調 → **やり直さない**。
  //    届いた後に応答だけ失敗した可能性があり、やり直すと二重に適用されるため。
  {
    const calls = stub([serverError, success]);
    const res = await sb.from("app_sessions").delete().eq("token", "dummy-not-real");
    ok("書き込み: 5xx は、やり直さない(二重適用を防ぐ)", calls() === 1, `calls=${calls()}(1回であるべき)`);
  }

  // ⑤ 恒久的なエラー → やり直さずすぐ返す(待たせても直らない)
  {
    const calls = stub([notFound, success]);
    const res = await sb.from("app_users").select("id").limit(1);
    ok("恒久的なエラーは、やり直さない", calls() === 1 && !!res.error, `calls=${calls()}`);
  }

  // ⑥ ずっと失敗し続けるなら、諦めてエラーを返す(無限に粘らない)
  {
    const calls = stub([clockSkew]);
    const res = await sb.from("app_users").select("id").limit(1);
    ok("直らない場合は3回で諦める", calls() === 3 && !!res.error, `calls=${calls()}`);
  }

  globalThis.fetch = realFetch;
  console.log(`\n===== 結果: ${pass}件OK / ${fail}件NG =====\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  globalThis.fetch = realFetch;
  console.error("予期しないエラー:", e);
  process.exitCode = 1;
});
