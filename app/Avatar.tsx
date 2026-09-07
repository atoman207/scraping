"use client";

/**
 * セラーのプロフィール画像。
 *
 * 表示できるものを、この順番で試す:
 *   ① スクレイプして保存した画像URL(メルカリShopsのロゴはこれしか無い)
 *   ② セラーIDから組み立てたURL(通常セラーはIDだけで決まる。lib/avatar.ts 参照)
 *   ③ 名前の頭文字を色付きの丸で描く
 *
 * ②があるので、**プロフィールを取りに行っていないセラーでも画像が出る**。
 * 画像を設定していないセラーは②が403になるので、そのとき③へ落ちる。
 * 判定はブラウザ側でしかできない(読み込みに失敗して初めて分かる)ため、
 * クライアントコンポーネントにしている。
 */
import { useState } from "react";
import { avatarUrlFor } from "../lib/avatar";

/** 名前から 0-7 の色を決める。同じ名前なら必ず同じ色になる単純なハッシュ */
export function hueOf(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 977;
  return h % 8;
}

/** 頭文字。絵文字や記号もそのまま1文字として扱う */
export function initialOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  return Array.from(trimmed)[0];
}

type Props = {
  name: string;
  /** スクレイプして保存した画像URL(あれば優先) */
  url?: string | null;
  /** セラーの外部ID。これがあれば保存済みURLが無くても画像を出せる */
  externalId?: string | null;
  /** 既定36px / lg=56px / sm=26px */
  size?: "sm" | "md" | "lg";
  className?: string;
};

export default function Avatar({ name, url, externalId, size = "md", className = "" }: Props) {
  const src = avatarUrlFor(externalId, url);
  const [broken, setBroken] = useState(false);
  const cls = `avatar ${size === "lg" ? "avatar-lg" : size === "sm" ? "avatar-sm" : ""} ${className}`.trim();

  if (src && !broken) {
    return (
      <img
        className={cls}
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        // メルカリの画像CDNに参照元を送らない(送らなくても配信される)
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
      />
    );
  }
  return (
    <span className={cls} data-hue={hueOf(name)} aria-hidden="true" title={name}>
      {initialOf(name)}
    </span>
  );
}
