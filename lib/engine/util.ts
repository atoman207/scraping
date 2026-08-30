/** SQLite の julianday()/日付文字列まわりをTS側で再現するための小道具 */

/** "2026-08-04" / "2026-08-04 12:34:56" をUTCとして解釈する(SQLiteのjulianday()と同じ扱い) */
export function parseSqliteDate(v: string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  let iso = s.replace(" ", "T");
  if (!/[Zz]|[+-]\d{2}:?\d{2}$/.test(iso)) iso += "Z";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** julianday(soldAt) - julianday(listedAt) 相当。どちらか欠けていれば null */
export function turnoverDays(soldAt: string | null, listedAt: string | null): number | null {
  const a = parseSqliteDate(soldAt);
  const b = parseSqliteDate(listedAt);
  if (a === null || b === null) return null;
  return (a - b) / 86400000;
}

/** Python の sorted() と同じ、コードポイント順の文字列比較 */
export function codePointCompare(a: string, b: string): number {
  const ca = Array.from(a);
  const cb = Array.from(b);
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const x = ca[i].codePointAt(0)!;
    const y = cb[i].codePointAt(0)!;
    if (x !== y) return x - y;
  }
  return ca.length - cb.length;
}

export function mean(xs: number[]): number | null {
  if (!xs.length) return null;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}
