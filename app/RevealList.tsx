"use client";

/**
 * カードを少しずつ見せるための入れ物。
 *
 * SellerTable(①セラーリサーチ)と考え方は同じで、**中身はサーバーで組み立て、
 * 何件見せるかだけをここが決める**。カード1枚の描画には価格・利益計算・保存ボタンなど
 * 多くのものが必要なので、それをブラウザへ送らずに済ませたい。
 *
 * 表と違って <tr> の制約が無いので、ボタンはリストの下にそのまま置く。
 */
import { Children, useState } from "react";
import { IconChevronDown } from "./icons";

export default function RevealList({
  children,
  step = 10,
  unit = "件",
}: {
  children: React.ReactNode;
  /** 最初に見せる数、および1回押すごとに増える数 */
  step?: number;
  /** 残り件数の数え方 */
  unit?: string;
}) {
  const all = Children.toArray(children);
  const [visible, setVisible] = useState(step);

  const shown = all.slice(0, visible);
  const rest = all.length - shown.length;

  return (
    <>
      {shown}
      {rest > 0 && (
        <div className="reveal-more">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setVisible((v) => v + step)}>
            <IconChevronDown size={13} />
            もっと見る
            <span className="reveal-rest">
              残り{rest}
              {unit}
            </span>
          </button>
        </div>
      )}
    </>
  );
}
