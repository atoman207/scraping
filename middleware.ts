import { NextRequest, NextResponse } from "next/server";

/**
 * ログインしていない人を /login へ送る。
 *
 * ■ ここでやること / やらないこと
 *   middleware は Edge ランタイムで動くため、node:crypto も使えず、
 *   毎リクエストでDBを引くのも避けたい。そこで **Cookieの有無だけ** を見て、
 *   無ければログイン画面へ送る(これは体験のための振り分けであって、認可ではない)。
 *
 *   **本当の検証は必ずサーバー側で行う**。
 *   画面は app/layout.tsx が、サーバーアクションとAPIはそれぞれの入口が
 *   lib/auth.ts の currentUser() / requireAdmin() を通す。
 *   偽のCookieを付けてもここは通れるが、その先で弾かれる。
 *
 * ■ 旧Basic認証について
 *   BASIC_AUTH_USER / BASIC_AUTH_PASS を設定していれば、ログイン画面の**手前**に
 *   もう1枚Basic認証をかけられる(公開サーバーに置くときの二重の壁)。
 *   未設定なら何もしない。
 */
const SESSION_COOKIE = "tenbai_session";

/** ログインしていなくても開ける経路 */
const PUBLIC_PATHS = ["/login", "/api/auth"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // ① 任意の追加の壁(Basic認証)。設定されているときだけ有効
  const basicUser = process.env.BASIC_AUTH_USER;
  const basicPass = process.env.BASIC_AUTH_PASS;
  if (basicUser && basicPass) {
    const header = req.headers.get("authorization");
    let ok = false;
    if (header) {
      const [scheme, encoded] = header.split(" ");
      if (scheme === "Basic" && encoded) {
        const [u, p] = Buffer.from(encoded, "base64").toString("utf-8").split(":");
        ok = u === basicUser && p === basicPass;
      }
    }
    if (!ok) {
      return new NextResponse("認証が必要です", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="tenbai-tool"' },
      });
    }
  }

  // ② ログイン画面そのものと、ログインAPIは素通しする
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  // ③ セッションCookieが無ければログイン画面へ。戻り先を next に持たせる
  if (!req.cookies.get(SESSION_COOKIE)?.value) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    const back = pathname + (req.nextUrl.search || "");
    if (back && back !== "/") url.searchParams.set("next", back);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

// APIルートを増やした場合もここにマッチするので、静的アセットだけ除外
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon(?:\\.png)?|apple-icon(?:\\.png)?|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
