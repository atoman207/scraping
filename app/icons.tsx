/**
 * 画面で使うアイコン。外部パッケージを足さずに済むよう、必要な分だけ
 * インラインSVG(lucide互換のストローク指定)で持つ。
 * currentColor を使っているので、親のCSSの色がそのまま乗る。
 *
 * 描き方の決まり:
 *  - 24×24のグリッド、線幅2、端と角は丸。太さと余白を揃えると、並べたときに整って見える
 *  - 塗りは使わない(色はCSS側の currentColor だけで決める)
 *  - 意味が一目で分かる形を優先する。装飾のための線は足さない
 */
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function Base({ size = 16, children, strokeWidth = 2, ...rest }: P) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

// ---------------------------------------------------------------- ナビゲーション

/** 虫めがね: 検索 */
export const IconSearch = (p: P) => (
  <Base {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.2-3.2" />
  </Base>
);

/** 上向きの山かっこ: 小さい順に並べ替え */
export const IconChevronUp = (p: P) => (
  <Base {...p}>
    <path d="m6 15 6-6 6 6" />
  </Base>
);

/** 下向きの山かっこ: 続きを開く */
export const IconChevronDown = (p: P) => (
  <Base {...p}>
    <path d="m6 9 6 6 6-6" />
  </Base>
);

/** 人が2人: セラー(①セラーリサーチ) */
export const IconUsers = (p: P) => (
  <Base {...p}>
    <path d="M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20" />
    <circle cx="9" cy="7" r="3.2" />
    <path d="M22 20v-1.5a4 4 0 0 0-3-3.87" />
    <path d="M16.5 4.13a4 4 0 0 1 0 7.75" />
  </Base>
);

/** 重なった板: グループ化された商品(②セラー深掘り) */
export const IconLayers = (p: P) => (
  <Base {...p}>
    <path d="m12 2 9 5-9 5-9-5 9-5Z" />
    <path d="m3 12 9 5 9-5" />
    <path d="m3 17 9 5 9-5" />
  </Base>
);

/** 電卓: 利益計算(③深掘りリスト) */
export const IconCalculator = (p: P) => (
  <Base {...p}>
    <rect width="15" height="20" x="4.5" y="2" rx="2.5" />
    <path d="M8 6h8" />
    <path d="M8.5 11h.01M12 11h.01M15.5 11h.01" />
    <path d="M8.5 15h.01M12 15h.01M15.5 15h.01" />
    <path d="M8.5 18.5h7" />
  </Base>
);

/** 右肩上がりの折れ線: ブランドマーク */
export const IconTrend = (p: P) => (
  <Base {...p}>
    <path d="M3 17.5 9.5 11l4 4L21 7.5" />
    <path d="M15.5 7.5H21v5.5" />
  </Base>
);

// ---------------------------------------------------------------- 指標

/** 星: 評価 */
export const IconStar = ({ size = 14, ...rest }: P) => (
  <Base size={size} {...rest} fill="currentColor" strokeWidth={1.5}>
    <path d="m12 2.6 2.9 5.88 6.5.95-4.7 4.58 1.11 6.47L12 17.42l-5.81 3.06 1.11-6.47-4.7-4.58 6.5-.95L12 2.6Z" />
  </Base>
);

/** 値札: 価格 */
export const IconTag = (p: P) => (
  <Base {...p}>
    <path d="M11.6 2.6H4a1.4 1.4 0 0 0-1.4 1.4v7.6a2 2 0 0 0 .59 1.41l7.8 7.8a2 2 0 0 0 2.83 0l6.99-6.99a2 2 0 0 0 0-2.83l-7.8-7.8a2 2 0 0 0-1.41-.59Z" />
    <circle cx="7.5" cy="7.5" r="1.4" />
  </Base>
);

/** 時計: 回転日数 */
export const IconClock = (p: P) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="9.2" />
    <path d="M12 6.8V12l3.4 2" />
  </Base>
);

/** カレンダー: 出品日・売却日 */
export const IconCalendar = (p: P) => (
  <Base {...p}>
    <rect width="18" height="17" x="3" y="4.5" rx="2.5" />
    <path d="M8 2.5v4M16 2.5v4M3 10h18" />
  </Base>
);

/** トラック: 発送方法・実送料 */
export const IconTruck = (p: P) => (
  <Base {...p}>
    <path d="M14 17.5V6.5a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h1.2" />
    <path d="M14 9h3.6a2 2 0 0 1 1.7.95l1.9 3.1a2 2 0 0 1 .3 1.05v2.4a1 1 0 0 1-1 1h-1.3" />
    <path d="M9.8 18.5H14" />
    <circle cx="7" cy="18.5" r="2.2" />
    <circle cx="17.5" cy="18.5" r="2.2" />
  </Base>
);

/** 箱: 出品数・在庫 */
export const IconBox = (p: P) => (
  <Base {...p}>
    <path d="M21 8.2a2 2 0 0 0-1.03-1.75l-7-3.9a2 2 0 0 0-1.94 0l-7 3.9A2 2 0 0 0 3 8.2v7.6a2 2 0 0 0 1.03 1.75l7 3.9a2 2 0 0 0 1.94 0l7-3.9A2 2 0 0 0 21 15.8Z" />
    <path d="m3.4 7.3 8.6 4.8 8.6-4.8" />
    <path d="M12 21.4V12.1" />
  </Base>
);

/** 炎: 鉄板商品(繰り返し売れている) */
export const IconFlame = (p: P) => (
  <Base {...p}>
    <path d="M12 2.5c.9 2.6 2.5 4 4 5.6 1.9 2 3 3.9 3 6.2a7 7 0 1 1-14 0c0-1.5.5-2.8 1.3-3.9.3 1.2 1 2 1.9 2.3-.3-2.6.6-5.1 2.5-7 .7-.7 1.1-1.9 1.3-3.2Z" />
    <path d="M12 20.5a3.3 3.3 0 0 0 3.3-3.3c0-1.5-1-2.5-1.8-3.3-.6.9-1.4 1.3-2.4 1.4-1 .6-1.7 1.2-1.7 2.4A3.2 3.2 0 0 0 12 20.5Z" />
  </Base>
);

/** 円グラフ: 新品率 */
export const IconPie = (p: P) => (
  <Base {...p}>
    <path d="M21.2 15.6A9.6 9.6 0 1 1 8.4 2.9" />
    <path d="M21.6 11.6A9.6 9.6 0 0 0 12 2.4v9.2Z" />
  </Base>
);

/** 上向き矢印: 月販数 */
export const IconArrowUp = (p: P) => (
  <Base {...p}>
    <path d="M12 20V4.6" />
    <path d="m5.5 11 6.5-6.5 6.5 6.5" />
  </Base>
);

/** 二重の円: 黒字ライン(目標値) */
export const IconTarget = (p: P) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="9.2" />
    <circle cx="12" cy="12" r="5" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" />
  </Base>
);

/** ぐるりと回る矢印: 再出品 */
export const IconRepeat = (p: P) => (
  <Base {...p}>
    <path d="M3 10.5V9a3 3 0 0 1 3-3h12" />
    <path d="m15.5 2.5 3 3.5-3 3.5" />
    <path d="M21 13.5V15a3 3 0 0 1-3 3H6" />
    <path d="m8.5 21.5-3-3.5 3-3.5" />
  </Base>
);

/** リボン付きの円: セラー分類 */
export const IconAward = (p: P) => (
  <Base {...p}>
    <circle cx="12" cy="9" r="6.2" />
    <path d="M8.4 14.3 7 22l5-2.6L17 22l-1.4-7.7" />
  </Base>
);

// ---------------------------------------------------------------- 操作

/** フロッピー: 保存 */
export const IconSave = (p: P) => (
  <Base {...p}>
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
    <path d="M17 21v-7H7v7" />
    <path d="M7 3v5h7" />
  </Base>
);

/** 回る矢印: 再取得・更新 */
export const IconRefresh = (p: P) => (
  <Base {...p}>
    <path d="M20.5 11.5a8.5 8.5 0 0 0-14.6-5.1L3 9.2" />
    <path d="M3.5 12.5a8.5 8.5 0 0 0 14.6 5.1L21 14.8" />
    <path d="M3 4.5v4.7h4.7M21 19.5v-4.7h-4.7" />
  </Base>
);

/** 円弧: 読み込み中(.spin と組み合わせて回す) */
export const IconLoader = (p: P) => (
  <Base {...p}>
    <path d="M12 3.2a8.8 8.8 0 1 0 8.8 8.8" />
  </Base>
);

/** 外部リンク */
export const IconExternal = (p: P) => (
  <Base {...p}>
    <path d="M14 4.5h5.5V10" />
    <path d="m19 5-8 8" />
    <path d="M19.5 14v4.5a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2H10" />
  </Base>
);

/** 右向き矢印: 次の画面へ */
export const IconArrowRight = (p: P) => (
  <Base {...p}>
    <path d="M4.5 12h14.2" />
    <path d="m12.5 5.5 6.5 6.5-6.5 6.5" />
  </Base>
);

/** チェック: 完了 */
export const IconCheck = (p: P) => (
  <Base {...p}>
    <path d="m4.5 12.5 5 5 10-11" />
  </Base>
);

/** 歯車: 設定 */
export const IconSettings = (p: P) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 14.5a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-.97 1.46V21a2 2 0 1 1-4 0v-.11a1.6 1.6 0 0 0-1.05-1.46 1.6 1.6 0 0 0-1.77.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.46-.97H3a2 2 0 1 1 0-4h.11a1.6 1.6 0 0 0 1.46-1.05 1.6 1.6 0 0 0-.32-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.6 1.6 0 0 0 1.77.32H9a1.6 1.6 0 0 0 .97-1.46V3a2 2 0 1 1 4 0v.11a1.6 1.6 0 0 0 .97 1.46 1.6 1.6 0 0 0 1.77-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.6 1.6 0 0 0-.32 1.77V9a1.6 1.6 0 0 0 1.46.97H21a2 2 0 1 1 0 4h-.11a1.6 1.6 0 0 0-1.46.97Z" />
  </Base>
);

/** 買い物かご */
export const IconCart = (p: P) => (
  <Base {...p}>
    <circle cx="9" cy="20" r="1.6" />
    <circle cx="18" cy="20" r="1.6" />
    <path d="M2.5 3h2.3l2.5 12.1a1.6 1.6 0 0 0 1.6 1.3h8.9a1.6 1.6 0 0 0 1.57-1.28L21 7.5H6" />
  </Base>
);

// ---------------------------------------------------------------- 通知

/** 三角の中に!: 警告 */
export const IconAlert = (p: P) => (
  <Base {...p}>
    <path d="M10.3 3.9 2.5 17.4a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9.5v4" />
    <path d="M12 17.2h.01" />
  </Base>
);

/** 丸の中にi: 補足 */
export const IconInfo = (p: P) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="9.2" />
    <path d="M12 16v-4.5" />
    <path d="M12 8h.01" />
  </Base>
);

/** 受信トレイ: 空状態 */
export const IconInbox = (p: P) => (
  <Base {...p}>
    <path d="M21 12h-5l-1.5 3h-5L8 12H3" />
    <path d="M5.5 5.2 3.3 11a2 2 0 0 0-.3 1v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-.3-1l-2.2-5.8a2 2 0 0 0-1.86-1.28H7.36A2 2 0 0 0 5.5 5.2Z" />
  </Base>
);

// ---------------------------------------------------------------- 会員管理

/** 人ひとり: 利用者 */
export const IconUser = (p: P) => (
  <Base {...p}>
    <path d="M19 20v-1.5a5 5 0 0 0-5-5h-4a5 5 0 0 0-5 5V20" />
    <circle cx="12" cy="7.5" r="3.7" />
  </Base>
);

/** 人に+: 利用者を追加 */
export const IconUserPlus = (p: P) => (
  <Base {...p}>
    <path d="M15.5 20v-1.5a5 5 0 0 0-5-5H7a5 5 0 0 0-5 5V20" />
    <circle cx="8.7" cy="7.5" r="3.7" />
    <path d="M19 8v6M22 11h-6" />
  </Base>
);

/** 盾: 管理者 */
export const IconShield = (p: P) => (
  <Base {...p}>
    <path d="M12 2.5 4.5 5.6v5.6c0 4.6 3.2 8.9 7.5 10.3 4.3-1.4 7.5-5.7 7.5-10.3V5.6Z" />
    <path d="m9.2 12 2 2 3.6-3.9" />
  </Base>
);

/** 鍵: パスワード */
export const IconKey = (p: P) => (
  <Base {...p}>
    <circle cx="7.5" cy="15.5" r="4" />
    <path d="m10.4 12.6 8.1-8.1" />
    <path d="m16.5 6.5 2 2" />
    <path d="m14 9 2.5 2.5" />
  </Base>
);

/** 南京錠: ログイン */
export const IconLock = (p: P) => (
  <Base {...p}>
    <rect width="15" height="10" x="4.5" y="11.5" rx="2.5" />
    <path d="M8 11.5V8a4 4 0 0 1 8 0v3.5" />
    <path d="M12 15.5v2" />
  </Base>
);

/** 扉から出る矢印: ログアウト */
export const IconLogout = (p: P) => (
  <Base {...p}>
    <path d="M9.5 20.5H6a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h3.5" />
    <path d="m15.5 16.5 4.5-4.5-4.5-4.5" />
    <path d="M20 12H9.5" />
  </Base>
);

/** さいころ: ランダム生成 */
export const IconDice = (p: P) => (
  <Base {...p}>
    <rect width="17" height="17" x="3.5" y="3.5" rx="3" />
    <path d="M8.5 8.5h.01M15.5 8.5h.01M12 12h.01M8.5 15.5h.01M15.5 15.5h.01" />
  </Base>
);

/** 2枚の紙: コピー */
export const IconCopy = (p: P) => (
  <Base {...p}>
    <rect width="12" height="12" x="8.5" y="8.5" rx="2" />
    <path d="M4.5 15.5A2 2 0 0 1 3.5 14V5.5a2 2 0 0 1 2-2H14a2 2 0 0 1 1.5.7" />
  </Base>
);

/** ごみ箱: 削除 */
export const IconTrash = (p: P) => (
  <Base {...p}>
    <path d="M3.5 6h17" />
    <path d="M8.5 6V4.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5V6" />
    <path d="M18.5 6v13a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V6" />
    <path d="M10 10.5v6M14 10.5v6" />
  </Base>
);

/** 鉛筆: 編集 */
export const IconEdit = (p: P) => (
  <Base {...p}>
    <path d="M11 4.5H5.5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V13" />
    <path d="M17.4 3.1a2 2 0 0 1 2.83 2.83L12.6 13.5l-3.6.9.9-3.6Z" />
  </Base>
);

/** 目: 表示切り替え */
export const IconEye = (p: P) => (
  <Base {...p}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="3" />
  </Base>
);

/** 目に斜線: 非表示 */
export const IconEyeOff = (p: P) => (
  <Base {...p}>
    <path d="M9.9 5.7A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.8 3.7" />
    <path d="M6.3 7.7A17 17 0 0 0 2.5 12S6 18.5 12 18.5a9.7 9.7 0 0 0 4-.85" />
    <path d="M10 10a2.9 2.9 0 0 0 4 4" />
    <path d="m3 3 18 18" />
  </Base>
);

/** 丸に+: 追加 */
export const IconPlus = (p: P) => (
  <Base {...p}>
    <path d="M12 5v14M5 12h14" />
  </Base>
);

/** バツ: 閉じる・無効 */
export const IconX = (p: P) => (
  <Base {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Base>
);

/** ろうと: 絞り込み */
export const IconFilter = (p: P) => (
  <Base {...p}>
    <path d="M21 4.5H3l7.2 8.5v5.6l3.6 1.9V13Z" />
  </Base>
);

/** 写真: 画像検索(3-3) */
export const IconImage = (p: P) => (
  <Base {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="8.5" cy="9.5" r="1.5" />
    <path d="m4 17 4.5-4.5 3.5 3.5 3-3L20 17" />
  </Base>
);

/** 地球: 海外サイト(AliExpress / 1688) */
export const IconGlobe = (p: P) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3c2.5 2.7 3.8 5.7 3.8 9S14.5 18.3 12 21c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3Z" />
  </Base>
);
