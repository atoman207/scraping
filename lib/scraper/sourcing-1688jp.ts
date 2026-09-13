/**
 * 1688Japan(1688の日本公式総代理店)経由で 1688 の商品を探す。
 *
 * ■ なぜ 1688.com を直接見ないのか
 *   1688.com は商品詳細・キーワード検索・画像検索のすべてがログイン必須で、
 *   サーバーからは一度もページを開けない(README 3-3 に実測表がある)。
 *   ログインの偽装もCAPTCHAの自動突破もしない方針なので、その経路は使えない。
 *
 * ■ 1688Japan を使う
 *   1688Japan は「アリババ1688の日本唯一の公式総代理店」で、
 *   検索画面に「こちらの検索は、1688より一部技術、情報サポートを受けて提供させて頂いております」
 *   と明記されている。**正規に1688のデータを扱っている事業者**なので、
 *   自社アカウントでログインして、その画面が使っているのと同じ経路で取得する。
 *
 * ■ ブラウザは使わない
 *   認証はCookieの `token` ひとつで通るため、HTTPだけで完結する。
 *   Playwright を起動しないぶん速く、壊れにくい(DOMの作りに依存しない)。
 *
 * ■ 画像検索の流れ(3回の呼び出し)
 *   1. GET  /oss/upload-ticket?type=image-search  … 署名付きアップロード先をもらう
 *   2. POST <OSSのhost>                            … 写真をそこへ置く
 *   3. POST /goods/image-search                    … 置いた写真のURLで検索
 *   先方のサーバーはメルカリのCDNから直接画像を取れない(image_download_failed)ため、
 *   2 を飛ばして 1 の public_url 以外を渡すことはできない。
 *
 * ■ ログインについて
 *   ログイン画面に画像の確認コードがあるので自動ではログインしない。
 *   人が1回ログインして保存したセッション(secrets/1688japan-state.json)を読む。
 *     npm run login:1688jp
 */
import {
  apiHeaders,
  Missing1688JpSession,
  readToken,
  sessionPath,
  touchSession,
} from "./session-1688jp";
import type { SourcingCandidate } from "./types";

const API_BASE = "https://api.hhocool.com/omni-center/hz/api/taotaro";
const SITE = "https://pro.1688japan.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

// セッションの読み書きと生存確認は session-1688jp.ts が持つ。
// ここからも今までどおり使えるように再輸出しておく。
export { Missing1688JpSession, sessionPath, touchSession };

type RawItem = {
  goodsId?: string;
  title?: string | null;
  titleTrans?: string | null;
  imageUrl?: string | null;
  price?: string | null;
  promotionPrice?: string | null;
  consignPrice?: string | null;
  monthSold?: number | null;
  repurchaseRate?: string | null;
  tradeScore?: string | null;
  minOrderQuantity?: number | null;
  sellerIdentities?: string[] | null;
  offerIdentities?: string[] | null;
  createDate?: string | null;
};

type ApiResponse = {
  success?: boolean;
  data?: { items?: RawItem[]; totalRecords?: number | null; failReason?: string | null };
  detail?: unknown;
};

/** 店の種別。画面にそのまま出せる日本語にする */
const BADGE_LABEL: Record<string, string> = {
  powerful_merchants: "実力商家",
  super_factory: "厳選工場",
  tp_member: "誠信通",
  yx: "1688厳選",
};

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export type Jp1688Options = {
  /** 1回の検索で受け取る件数(上限50。相手のAPIの既定値と同じ) */
  limit?: number;
  log?: (m: string) => void;
};

/**
 * 1688Japan の検索API。
 *
 * 使い終わったあとに閉じるものは無い(HTTPだけで、ブラウザを持たない)。
 */
export class Sourcing1688Jp {
  readonly platformName = "1688";
  private token: string;
  private log: (m: string) => void;
  private limit: number;

  constructor(opts: Jp1688Options = {}) {
    this.token = readToken();
    this.log = opts.log ?? (() => {});
    this.limit = Math.min(Math.max(opts.limit ?? 30, 1), 50);
  }

  /** セッションが生きているか確かめる(利用者名を返す) */
  static async check(): Promise<{ ok: boolean; user?: string; reason?: string }> {
    const r = await touchSession();
    return { ok: r.ok, user: r.user, reason: r.reason };
  }

  /** 中国語のキーワードで探す */
  async searchByKeyword(zhQuery: string): Promise<SourcingCandidate[]> {
    if (!zhQuery.trim()) return [];
    this.log(`  1688 キーワード検索: 「${zhQuery}」`);
    const res = await this.post(`${API_BASE}/goods/search`, {
      keyword: zhQuery,
      platform: "1688",
      page: 1,
      limit: this.limit,
    });
    const items = res.data?.items ?? [];
    this.log(`  → ${items.length}件`);
    return items.map((it, i) => this.toCandidate(it, "title", zhQuery, i + 1));
  }

  /**
   * 写真で探す。
   *
   * 先方のサーバーはメルカリのCDNから画像を取れないので、
   * **こちらで写真を落として、先方のアップロード先へ置いてから**検索する。
   */
  async searchByPhoto(photoUrl: string, nth = 1, total = 1): Promise<SourcingCandidate[]> {
    const tag = total > 1 ? `写真${nth}/${total}` : "画像";

    let bytes: Buffer;
    try {
      bytes = await this.downloadPhoto(photoUrl);
    } catch (e) {
      // 写真が少ない出品では存在しない番号が403を返す。異常ではないので静かに飛ばす
      this.log(`  1688 ${tag}: 使えませんでした (${String(e instanceof Error ? e.message : e).slice(0, 80)})`);
      return [];
    }

    let publicUrl: string;
    try {
      publicUrl = await this.upload(bytes);
    } catch (e) {
      this.log(`  1688 ${tag}: アップロードに失敗 (${String(e instanceof Error ? e.message : e).slice(0, 100)})`);
      return [];
    }

    const res = await this.post(`${API_BASE}/goods/image-search`, {
      imageUrl: publicUrl,
      platform: "1688",
      page: 1,
      limit: this.limit,
    });
    if (res.data?.failReason) {
      this.log(`  1688 ${tag}: 検索できませんでした (${res.data.failReason})`);
      return [];
    }
    const items = res.data?.items ?? [];
    this.log(`  1688 ${tag}: ${items.length}件`);
    return items.map((it, i) => this.toCandidate(it, "image", publicUrl, i + 1));
  }

  // ------------------------------------------------------------ 中身

  private async post(url: string, body: unknown): Promise<ApiResponse> {
    const r = await fetch(url, {
      method: "POST",
      headers: apiHeaders(this.token, true),
      body: JSON.stringify(body),
    });
    if (r.status === 401 || r.status === 403) {
      throw new Missing1688JpSession("1688Japan のセッションが切れています。");
    }
    const text = await r.text();
    let j: ApiResponse;
    try {
      j = JSON.parse(text) as ApiResponse;
    } catch {
      throw new Error(`1688Japan の応答を解釈できませんでした (HTTP ${r.status})`);
    }
    if (!r.ok || j.success === false) {
      const detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? {}).slice(0, 200);
      throw new Error(`1688Japan の検索に失敗しました (HTTP ${r.status}) ${detail}`);
    }
    return j;
  }

  /** 写真を落とす。メルカリのCDNはリファラを見ることがあるので名乗っておく */
  private async downloadPhoto(url: string): Promise<Buffer> {
    const r = await fetch(url, {
      headers: { "user-agent": UA, Referer: "https://jp.mercari.com/", Accept: "image/*,*/*;q=0.8" },
    });
    if (!r.ok) throw new Error(`写真を取得できません (HTTP ${r.status})`);
    const type = (r.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!type.startsWith("image/")) throw new Error(`画像ではありませんでした (${type || "種類不明"})`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1024) throw new Error("画像が小さすぎます(取得に失敗している可能性)");
    if (buf.length > 8 * 1024 * 1024) throw new Error(`画像が大きすぎます (${Math.round(buf.length / 1024)}KB)`);
    return buf;
  }

  /**
   * 先方のアップロード先(Alibaba OSS)へ写真を置いて、公開URLを受け取る。
   * 署名は毎回もらい直す(有効期限が短い)。
   */
  private async upload(bytes: Buffer): Promise<string> {
    const tr = await fetch(`${API_BASE}/oss/upload-ticket?type=image-search`, { headers: apiHeaders(this.token) });
    if (tr.status === 401 || tr.status === 403) {
      throw new Missing1688JpSession("1688Japan のセッションが切れています。");
    }
    const tj = (await tr.json()) as {
      success?: boolean;
      data?: {
        host: string;
        key: string;
        policy: string;
        x_oss_signature_version: string;
        x_oss_credential: string;
        x_oss_date: string;
        signature: string;
        public_url: string;
      };
    };
    const t = tj.data;
    if (!tj.success || !t?.host) throw new Error("アップロード先を受け取れませんでした");

    const form = new FormData();
    form.append("key", t.key);
    form.append("policy", t.policy);
    form.append("x-oss-signature-version", t.x_oss_signature_version);
    form.append("x-oss-credential", t.x_oss_credential);
    form.append("x-oss-date", t.x_oss_date);
    form.append("x-oss-signature", t.signature);
    form.append("success_action_status", "200");
    form.append("file", new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }), "search.jpg");

    const up = await fetch(t.host, {
      method: "POST",
      body: form,
      headers: { "user-agent": UA, referer: `${SITE}/`, origin: SITE },
    });
    if (!up.ok) {
      throw new Error(`アップロードに失敗しました (HTTP ${up.status}) ${(await up.text()).slice(0, 160)}`);
    }
    return t.public_url;
  }

  /** APIの1件を、こちらの候補の形に直す */
  private toCandidate(
    it: RawItem,
    mode: "title" | "image",
    query: string,
    rank: number
  ): SourcingCandidate {
    const id = String(it.goodsId ?? "");
    // 実際に払う値段は、特価があればそちら
    const cny = toNum(it.promotionPrice) ?? toNum(it.price) ?? toNum(it.consignPrice);
    const badges = [...(it.sellerIdentities ?? []), ...(it.offerIdentities ?? [])]
      .map((b) => BADGE_LABEL[b] ?? b)
      .filter(Boolean);

    return {
      source_platform: "1688",
      search_mode: mode,
      query,
      external_id: id || null,
      // 1688Japan は日本語に訳したタイトルを返す(1688の原文は中国語)
      title: (it.title || it.titleTrans || "").slice(0, 300) || `1688 商品 ${id}`,
      price: cny,
      currency: "CNY",
      price_jpy: null, // 円換算は共通設定の為替で呼び出し側が入れる
      price_cny: cny,
      url: id ? `https://detail.1688.com/offer/${id}.html` : SITE,
      image_url: it.imageUrl ?? null,
      min_order_qty: toNum(it.minOrderQuantity),
      orders_count: toNum(it.monthSold),
      rating: toNum(it.tradeScore),
      is_ad: false,
      // 文字列の一致度は使わない。日本語訳どうしの比較になり、意味を持たないため
      match_score: null,
      source_rank: rank,
      // 1688 にしかない「店の信用度」
      repeat_rate: toNum(it.repurchaseRate),
      badges: badges.length ? badges : null,
      listed_at: it.createDate ?? null,
    };
  }
}
