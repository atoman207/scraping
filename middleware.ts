import { NextRequest, NextResponse } from "next/server";

/**
 * サイト全体にBasic認証をかける。
 * BASIC_AUTH_USER / BASIC_AUTH_PASS を .env.local (または本番のホスティング先の
 * 環境変数設定)で指定し、友人だけにそのID/パスワードを個別に伝える運用を想定。
 *
 * 注意:
 *  - Basic認証は通信経路が暗号化されていないと平文で流れるため、必ずhttps環境
 *    (Vercel等にデプロイした場合は自動でhttps)で使うこと。
 *  - 複数人に配る場合はユーザーごとに使い回さず、都度パスワードを変更するのが安全。
 */
export function middleware(req: NextRequest) {
  const user = process.env.BASIC_AUTH_USER;
  const pass = process.env.BASIC_AUTH_PASS;

  // 環境変数が未設定なら認証をスキップ(ローカル開発時に毎回聞かれないように)
  if (!user || !pass) {
    return NextResponse.next();
  }

  const authHeader = req.headers.get("authorization");
  if (authHeader) {
    const [scheme, encoded] = authHeader.split(" ");
    if (scheme === "Basic" && encoded) {
      const decoded = Buffer.from(encoded, "base64").toString("utf-8");
      const [reqUser, reqPass] = decoded.split(":");
      if (reqUser === user && reqPass === pass) {
        return NextResponse.next();
      }
    }
  }

  return new NextResponse("認証が必要です", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="tenbai-tool"' },
  });
}

// APIルートを増やした場合もここにマッチするので、静的アセットだけ除外
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
