/** @type {import('next').NextConfig} */
const nextConfig = {
  // playwright は「常駐サーバーでスクレイピングするとき」だけ使う。
  // サーバーレスにデプロイしたときに関数へ同梱されると、サイズ超過や
  // ビルド時間の無駄になるだけなので、バンドルから外す。
  // (lib/scraper/browser.ts が動的importしているので、必要な環境では実行時に解決される)
  experimental: {
    serverComponentsExternalPackages: ["playwright", "playwright-core"],
    outputFileTracingExcludes: {
      "/api/scrape": [
        "node_modules/playwright/**",
        "node_modules/playwright-core/**",
        "node_modules/@playwright/**",
      ],
    },
  },

  // メルカリ/AliExpressのサムネイルを <img> で直接読むため、
  // next/image の最適化は使っていない(外部ドメインの設定は不要)。
  images: { unoptimized: true },
};

module.exports = nextConfig;
