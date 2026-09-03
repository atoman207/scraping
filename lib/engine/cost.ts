/**
 * 原価・利益の計算エンジン（Seller Scope 準拠 ＋ 改良）
 *
 * 既存の lib/db.ts の計算式は「元のPython版と一字一句同じ」であることが README の
 * 約束なので触っていない。こちらは**上位互換の新しい式**として独立させ、
 * 深掘りリストの計算はこちらに寄せる。
 *
 * ── 既存 lib/db.ts の式に足りなかったもの（Seller Scope 調査で判明）──
 *   1. 中国国内送料（工場→代行倉庫）が原価に入っていない
 *   2. 関税が入っていない（品目によって 0〜10% 違う）
 *   3. 梱包費が利益から引かれていない
 *   4. 回転日数に下限が無く、0.2日などで月販数が爆発する（30/0.2 = 150個/月）
 *   5. 予想月販の手入力ができない（回転日数からの自動計算のみ）
 *   6. 「仕入先が決まっていない」状態を表現できない（候補価格の幅で見たい）
 *
 * ── Seller Scope より良くしている点 ──
 *   A. 輸入消費税を任意で計上できる（既定 0% ＝ Seller Scope 互換。彼らは未計上）
 *   B. 月販数の根拠（手入力か回転日数か）を返し、画面で区別できる
 *   C. 原価の内訳を構造化して返すので、画面でそのまま明細表示できる
 *   D. 仕入先未確定時に候補価格の最安〜最高から利益を「幅」で出せる
 *
 * 金額の単位は「円」、仕入値まわりは「元(CNY)」。丸めは最終値のみ。
 */

/** 関税の簡易区分。税率は Seller Scope と同一（実務でよく使う概算値）。 */
export const TARIFF_CATEGORIES = {
  clothing: { label: "衣類・衣類附属品 等", pct: 10 },
  plastic: { label: "プラ/ガラス/卑金属/家具 等", pct: 3 },
  rubber: { label: "ゴム/紙/陶磁器/鉄鋼/すず（無税）", pct: 0 },
  other: { label: "その他", pct: 5 },
} as const;

export type TariffCategory = keyof typeof TARIFF_CATEGORIES;

export function tariffPct(cat: string | null | undefined): number {
  return (TARIFF_CATEGORIES[cat as TariffCategory] ?? TARIFF_CATEGORIES.other).pct;
}

/** 原価計算の共通設定（アカウント単位）。settings テーブルの値をそのまま渡す。 */
export type CostSettings = {
  /** 為替レート 円/元 */
  exchange_rate_jpy_per_cny: number;
  /** 代行手数料 % */
  agent_fee_pct: number;
  /** 国際送料 元/kg */
  intl_shipping_cny_per_kg: number;
  /** 1箱の重量 kg */
  box_weight_kg: number;
  /**
   * 輸入消費税 %。既定 0 = Seller Scope 互換（彼らは計上していない）。
   * 実際に納めている場合だけ 10 などを設定する。
   */
  import_tax_pct?: number | null;
};

/** 1商品ぶんの原価入力。null は「未入力」を意味する。 */
export type CostInput = {
  /** 'detail' = 単価・送料・関税から積み上げ / 'direct' = 原価(円)を直接入力 */
  cost_mode?: "detail" | "direct" | null;
  /** cost_mode='direct' のときの原価(円) */
  cost_direct_jpy?: number | null;

  /** 商品単価(元) */
  item_cny?: number | null;
  /** 中国国内送料(元) 工場→代行倉庫 */
  domestic_cny?: number | null;
  /** 関税区分 */
  tariff_cat?: string | null;
  /** 1箱に何個入るか。国際送料の按分に使う */
  box_count?: number | null;
};

export type CostBreakdown = {
  /** 商品単価(円換算) */
  item: number;
  /** 代行手数料(円) */
  agentFee: number;
  /** 中国国内送料(円) */
  domestic: number;
  /** 関税(円) */
  tariff: number;
  /** 輸入消費税(円)。import_tax_pct が 0/未設定なら 0 */
  importTax: number;
  /** 国際送料(円/個) */
  intlShipping: number;
};

export type CostResult = {
  /** 原価(円)。入力が足りず計算できないときは null */
  jpy: number | null;
  /** 内訳(円)。cost_mode='direct' や計算不能時は null */
  breakdown: CostBreakdown | null;
  /** 計算できなかった理由（画面にそのまま出せる日本語） */
  reason: string | null;
};

/**
 * 原価(円)を求める。
 *
 *   国際送料(元/個) = 国際送料(元/kg) × 箱重量(kg) ÷ 箱入数
 *   原価(元) = 商品単価
 *            + 商品単価 × 代行手数料%
 *            + 中国国内送料
 *            + 商品単価 × 関税%
 *            + 国際送料(元/個)
 *   原価(円) = 原価(元) × 為替レート  （＋ 輸入消費税があればその分）
 *
 * 箱入数が未入力なら国際送料は 0 として扱う（Seller Scope と同じ挙動）。
 * 商品単価が未入力なら「原価は出せない」＝ null を返す。
 */
export function calcCost(input: CostInput, s: CostSettings): CostResult {
  if (input.cost_mode === "direct") {
    const v = input.cost_direct_jpy;
    if (v === null || v === undefined) return { jpy: null, breakdown: null, reason: "原価が未入力です" };
    return { jpy: Math.round(v), breakdown: null, reason: null };
  }

  const item = input.item_cny;
  if (item === null || item === undefined) {
    return { jpy: null, breakdown: null, reason: "仕入単価が未入力です" };
  }

  const rate = s.exchange_rate_jpy_per_cny;
  const domestic = input.domestic_cny ?? 0;
  const boxCount = input.box_count ?? 0;
  const tPct = tariffPct(input.tariff_cat);
  const taxPct = s.import_tax_pct ?? 0;

  // 箱入数が0/未入力なら按分できないので国際送料は載せない
  const intlCny = boxCount > 0 ? (s.intl_shipping_cny_per_kg * s.box_weight_kg) / boxCount : 0;

  const breakdown: CostBreakdown = {
    item: item * rate,
    agentFee: ((item * s.agent_fee_pct) / 100) * rate,
    domestic: domestic * rate,
    tariff: ((item * tPct) / 100) * rate,
    importTax: 0,
    intlShipping: intlCny * rate,
  };
  // 輸入消費税は「課税価格(商品代＋国際送料)＋関税」に対してかかる
  if (taxPct > 0) {
    breakdown.importTax = ((breakdown.item + breakdown.intlShipping + breakdown.tariff) * taxPct) / 100;
  }

  const total =
    breakdown.item + breakdown.agentFee + breakdown.domestic + breakdown.tariff + breakdown.importTax + breakdown.intlShipping;

  return { jpy: Math.round(total), breakdown, reason: null };
}

/** 1商品ぶんの販売条件。 */
export type SaleInput = {
  /** 売価(円)。メルカリ平均落札価格をそのまま入れることが多い */
  sell_price_jpy?: number | null;
  /** 販売手数料 %（メルカリは10） */
  fee_pct?: number | null;
  /** 発送にかかる送料(円)。未取得なら null */
  shipping_jpy?: number | null;
  /** 梱包資材費(円) */
  packaging_jpy?: number | null;
  /** 平均回転日数（出品〜売却）。null = データなし */
  rotation_days?: number | null;
  /** 予想月販数の手入力。入っていれば回転日数より優先 */
  monthly_qty?: number | null;
};

export type ProfitResult = {
  /** 原価(円) */
  cost: number | null;
  /** 1個あたり利益(円) */
  perUnit: number | null;
  /** 予想月販数(個) */
  qty: number | null;
  /** 回転日数から自動算出した月販数。手入力と比較して見せるため別で返す */
  autoQty: number | null;
  /** 月販数の根拠 */
  qtySource: "manual" | "rotation" | null;
  /** 月利益(円) */
  monthly: number | null;
  /** この額以下で仕入れれば黒字になる原価の上限(円) */
  breakEvenCostJpy: number | null;
  /** 計算できなかった項目の理由（画面にそのまま出せる） */
  reason: string | null;
};

/**
 * 回転日数から予想月販数を出す。
 *
 * 回転0日（即売れ）だと 30/0 で発散するので **下限0.5日** を入れる（月60個が上限）。
 * これが無いと「回転0.1日 → 月300個 → 月利益30万円」のような非現実的な数字が出る。
 */
export function monthlyQtyFromRotation(rotationDays: number | null | undefined): number | null {
  if (rotationDays === null || rotationDays === undefined) return null;
  const rot = Math.max(Number(rotationDays) || 0, 0.5);
  return Math.round((30 / rot) * 10) / 10;
}

/**
 * 1個利益・月利益・黒字ライン原価をまとめて求める。
 *
 *   1個利益 = 売価 − 売価×手数料% − 送料 − 梱包費 − 原価
 *   月利益   = 1個利益 × 予想月販数
 *   黒字ライン原価 = 売価 − 売価×手数料% − 送料 − 梱包費   （＝1個利益が0になる原価）
 *
 * 送料が未取得(null)のときは「1個利益は出せないが黒字ラインは出せない」ため
 * どちらも null にし、reason に「送料入力待ち」を入れる。
 */
export function calcProfit(cost: CostInput, sale: SaleInput, s: CostSettings): ProfitResult {
  const c = calcCost(cost, s);
  const autoQty = monthlyQtyFromRotation(sale.rotation_days);
  const manual = sale.monthly_qty !== null && sale.monthly_qty !== undefined ? Number(sale.monthly_qty) : null;
  const qty = manual !== null ? manual : autoQty;
  const qtySource: ProfitResult["qtySource"] = manual !== null ? "manual" : autoQty !== null ? "rotation" : null;

  const base: ProfitResult = {
    cost: c.jpy,
    perUnit: null,
    qty,
    autoQty,
    qtySource,
    monthly: null,
    breakEvenCostJpy: null,
    reason: null,
  };

  const price = sale.sell_price_jpy;
  if (price === null || price === undefined) return { ...base, reason: "売価が未入力です" };
  if (sale.shipping_jpy === null || sale.shipping_jpy === undefined) return { ...base, reason: "送料入力待ち" };

  const fee = Math.min(100, Math.max(0, sale.fee_pct ?? 10));
  const ship = sale.shipping_jpy;
  const pack = sale.packaging_jpy ?? 0;

  // 売上から、原価以外に必ず出ていくものを引いた残り = 原価に使える上限
  const netSales = price - (price * fee) / 100 - ship - pack;
  const breakEvenCostJpy = Math.round(netSales);

  if (c.jpy === null) return { ...base, breakEvenCostJpy, reason: c.reason };

  const perUnit = Math.round(netSales - c.jpy);
  const monthly = qty !== null ? Math.round(perUnit * qty) : null;
  return { ...base, perUnit, monthly, breakEvenCostJpy, reason: null };
}

/**
 * 仕入先が未確定のとき、候補価格の最安〜最高から利益を「幅」で出す。
 * 画面では「+¥142 〜 +¥560（目安）」のように表示する。
 *
 * candidatesCny が空なら null（幅を出す根拠が無い）。
 */
export function calcProfitRange(
  candidatesCny: number[],
  cost: CostInput,
  sale: SaleInput,
  s: CostSettings
): { lo: ProfitResult; hi: ProfitResult } | null {
  const xs = candidatesCny.filter((v) => Number.isFinite(v) && v > 0);
  if (!xs.length) return null;
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  // 仕入値が高いほど利益は低いので、lo(利益の下限) = max(仕入値)
  return {
    lo: calcProfit({ ...cost, cost_mode: "detail", item_cny: max }, sale, s),
    hi: calcProfit({ ...cost, cost_mode: "detail", item_cny: min }, sale, s),
  };
}

/**
 * 深掘り結果の一覧に出す「黒字ライン仕入値」。
 * 原価の内訳をまだ入れていない段階で、売価と送料だけから概算するためのもの。
 *
 *   黒字ライン(円) = 売価 × (1 − 手数料%/100) − 送料
 *
 * 送料が取れていない商品は null（画面では「送料待ち」と出す）。
 */
export function breakEvenFromSale(
  avgPriceJpy: number | null | undefined,
  shippingJpy: number | null | undefined,
  feePct = 10
): number | null {
  if (avgPriceJpy === null || avgPriceJpy === undefined) return null;
  if (shippingJpy === null || shippingJpy === undefined) return null;
  return Math.round(avgPriceJpy * (1 - feePct / 100) - shippingJpy);
}

/**
 * 黒字ライン原価(円) を「元」に直す。仕入交渉のときはこちらの方が使いやすい。
 * 代行手数料・関税・国際送料を差し引いた「商品単価としていくらまで出せるか」を返す。
 */
export function breakEvenItemCny(
  breakEvenCostJpy: number | null,
  cost: CostInput,
  s: CostSettings
): number | null {
  if (breakEvenCostJpy === null) return null;
  const rate = s.exchange_rate_jpy_per_cny;
  if (!rate) return null;
  const boxCount = cost.box_count ?? 0;
  const intlCny = boxCount > 0 ? (s.intl_shipping_cny_per_kg * s.box_weight_kg) / boxCount : 0;
  const domestic = cost.domestic_cny ?? 0;
  const tPct = tariffPct(cost.tariff_cat);
  const taxPct = s.import_tax_pct ?? 0;

  // 原価(元) = item×(1 + 代行% + 関税%) + 国内送料 + 国際送料   ← 消費税を除いた形
  // 消費税は (item + 国際送料 + item×関税%) にかかるので、item の係数にまとめる
  const itemCoef =
    1 + s.agent_fee_pct / 100 + tPct / 100 + (taxPct / 100) * (1 + tPct / 100);
  const fixedCny = domestic + intlCny + (taxPct / 100) * intlCny;

  const totalCny = breakEvenCostJpy / rate;
  const v = (totalCny - fixedCny) / itemCoef;
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}
