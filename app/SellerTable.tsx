"use client";

/**
 * セラー一覧の表。並べ替えと「もっと見る」だけを受け持つ。
 *
 * ■ 行の中身はサーバーで作る
 *   1行ごとのアバター・判定バッジ・リンクの組み立ては、サーバーコンポーネント
 *   (app/(app)/page.tsx)がそのまま行う。ここはできあがった <tr> を children で
 *   受け取り、**並び順と表示件数だけ**を決める。行の描画に必要なものをブラウザへ
 *   送らずに済む。
 *
 * ■ 並べ替えの材料は別で受け取る
 *   できあがった <tr> からは数値を読めないので、並べ替えに使う値だけを keys として
 *   別に渡してもらう。keys[i] と i 番目の行が対応している前提で、添字を並べ替えてから
 *   行を並べ直す。
 *
 * ■ ヘッダーもここが持つ理由
 *   並べ替えボタンは <thead> の中にあり、行の並びと同じ状態を見る必要がある。
 *   サーバー側に <thead> を置いたままだと状態を共有できないため、表ごと預かる。
 */
import { Children, useMemo, useState } from "react";
import { IconChevronDown, IconChevronUp } from "./icons";

/** 並べ替えに使う値。行の表示順と同じ並びで渡すこと */
export type SellerSortKeys = {
  /** 分類の格付け(穴場3 > 特化2 > 複数1 > その他0)。未設定は null */
  type: number | null;
  /** 評価件数 */
  rating: number | null;
  /** 総SOLD */
  sold: number | null;
  /** 平均価格 */
  price: number | null;
  /** 回転日数 */
  turnover: number | null;
  /** 新品率 */
  newRate: number | null;
};

type Col = keyof SellerSortKeys;
type Dir = "asc" | "desc";

const COLUMNS: { col: Col; label: string; right: boolean }[] = [
  { col: "type", label: "分類", right: false },
  { col: "rating", label: "評価", right: true },
  { col: "sold", label: "総SOLD", right: true },
  { col: "price", label: "平均価格", right: true },
  { col: "turnover", label: "回転日数", right: true },
  { col: "newRate", label: "新品率", right: true },
];

/**
 * 値が無い行は、昇順でも降順でも**必ず最後**に置く。
 * 「-」の行が先頭に並ぶと、上位を見たいという目的から外れるため。
 */
function compare(a: number | null, b: number | null, dir: Dir): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return dir === "asc" ? a - b : b - a;
}

function SortButtons({
  col,
  active,
  onSort,
}: {
  col: Col;
  active: Dir | null;
  onSort: (col: Col, dir: Dir) => void;
}) {
  return (
    <span className="sort-btns">
      <button
        type="button"
        className="sort-btn"
        data-active={active === "asc" || undefined}
        onClick={() => onSort(col, "asc")}
        title="小さい順に並べ替え"
        aria-label="小さい順に並べ替え"
      >
        <IconChevronUp size={11} />
      </button>
      <button
        type="button"
        className="sort-btn"
        data-active={active === "desc" || undefined}
        onClick={() => onSort(col, "desc")}
        title="大きい順に並べ替え"
        aria-label="大きい順に並べ替え"
      >
        <IconChevronDown size={11} />
      </button>
    </span>
  );
}

export default function SellerTable({
  children,
  keys,
  step = 5,
}: {
  children: React.ReactNode;
  keys: SellerSortKeys[];
  /** 最初に見せる行数、および1回押すごとに増える行数 */
  step?: number;
}) {
  const rows = Children.toArray(children);
  const [sort, setSort] = useState<{ col: Col; dir: Dir } | null>(null);
  const [visible, setVisible] = useState(step);

  // 並べ替えは添字の入れ替えで行う。同値のときは元の順(＝おすすめ順)を保つ
  const order = useMemo(() => {
    const idx = rows.map((_, i) => i);
    if (!sort) return idx;
    return idx.sort((x, y) => compare(keys[x]?.[sort.col] ?? null, keys[y]?.[sort.col] ?? null, sort.dir) || x - y);
  }, [rows.length, keys, sort]);

  const shown = order.slice(0, visible);
  const rest = order.length - shown.length;

  return (
    <table className="data">
      <thead>
        <tr>
          <th>セラー</th>
          {COLUMNS.map(({ col, label, right }) => (
            <th key={col} className={right ? "tight right" : "tight"}>
              <span className="th-sort" data-right={right || undefined}>
                {label}
                <SortButtons col={col} active={sort?.col === col ? sort.dir : null} onSort={(c, d) => setSort({ col: c, dir: d })} />
              </span>
            </th>
          ))}
          <th className="tight"></th>
        </tr>
      </thead>
      <tbody>
        {shown.map((i) => rows[i])}
        {rest > 0 && (
          <tr className="reveal-row">
            {/* セラー + 並べ替え6列 + 操作列 = 8列 */}
            <td colSpan={8}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setVisible((v) => v + step)}>
                <IconChevronDown size={13} />
                もっと見る
                <span className="reveal-rest">残り{rest}人</span>
              </button>
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
