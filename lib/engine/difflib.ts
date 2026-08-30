/**
 * Python標準ライブラリ difflib.SequenceMatcher の移植(ratio() 相当)。
 *
 * engine/cluster_seller_listings.py の similarity() は
 *   SequenceMatcher(None, a, b).ratio()
 * を使っているため、Python版とまったく同じ数値を返す必要がある。
 * CPython Lib/difflib.py のアルゴリズム(__chain_b / find_longest_match /
 * get_matching_blocks / ratio)をそのまま写している。
 */

export type Match = { a: number; b: number; size: number };

export class SequenceMatcher {
  private a: string[];
  private b: string[];
  private b2j = new Map<string, number[]>();
  private bjunk = new Set<string>();
  private bpopular = new Set<string>();
  private matchingBlocks: Match[] | null = null;

  constructor(a: string, b: string, private autojunk = true) {
    // Pythonの文字列イテレーションはコードポイント単位なので Array.from を使う
    this.a = Array.from(a);
    this.b = Array.from(b);
    this.chainB();
  }

  /** CPython: SequenceMatcher.__chain_b */
  private chainB() {
    const b = this.b;
    const b2j = this.b2j;
    for (let i = 0; i < b.length; i++) {
      const arr = b2j.get(b[i]);
      if (arr) arr.push(i);
      else b2j.set(b[i], [i]);
    }

    // isjunk は None 相当(呼び出し側が渡していない)なので junk は空

    // autojunk: b が長い(200要素以上)ときだけ「頻出要素」をjunk扱いにする
    const n = b.length;
    if (this.autojunk && n >= 200) {
      const ntest = Math.floor(n / 100) + 1;
      for (const [elt, idxs] of Array.from(b2j.entries())) {
        if (idxs.length > ntest) {
          this.bpopular.add(elt);
          b2j.delete(elt);
        }
      }
    }
  }

  private isbjunk(ch: string): boolean {
    return this.bjunk.has(ch);
  }

  /** CPython: SequenceMatcher.find_longest_match */
  findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): Match {
    const { a, b, b2j } = this;
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;

    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      const js = b2j.get(a[i]);
      if (js) {
        for (const j of js) {
          if (j < blo) continue;
          if (j >= bhi) break;
          const k = (j2len.get(j - 1) ?? 0) + 1;
          newj2len.set(j, k);
          if (k > bestsize) {
            besti = i - k + 1;
            bestj = j - k + 1;
            bestsize = k;
          }
        }
      }
      j2len = newj2len;
    }

    while (besti > alo && bestj > blo && !this.isbjunk(b[bestj - 1]) && a[besti - 1] === b[bestj - 1]) {
      besti--;
      bestj--;
      bestsize++;
    }
    while (
      besti + bestsize < ahi &&
      bestj + bestsize < bhi &&
      !this.isbjunk(b[bestj + bestsize]) &&
      a[besti + bestsize] === b[bestj + bestsize]
    ) {
      bestsize++;
    }

    while (besti > alo && bestj > blo && this.isbjunk(b[bestj - 1]) && a[besti - 1] === b[bestj - 1]) {
      besti--;
      bestj--;
      bestsize++;
    }
    while (
      besti + bestsize < ahi &&
      bestj + bestsize < bhi &&
      this.isbjunk(b[bestj + bestsize]) &&
      a[besti + bestsize] === b[bestj + bestsize]
    ) {
      bestsize++;
    }

    return { a: besti, b: bestj, size: bestsize };
  }

  /** CPython: SequenceMatcher.get_matching_blocks */
  getMatchingBlocks(): Match[] {
    if (this.matchingBlocks) return this.matchingBlocks;
    const la = this.a.length;
    const lb = this.b.length;

    const queue: [number, number, number, number][] = [[0, la, 0, lb]];
    const matchingBlocks: Match[] = [];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop()!;
      const m = this.findLongestMatch(alo, ahi, blo, bhi);
      const { a: i, b: j, size: k } = m;
      if (k) {
        matchingBlocks.push(m);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    matchingBlocks.sort((x, y) => x.a - y.a || x.b - y.b || x.size - y.size);

    // 隣接するブロックをマージする(CPythonと同じ手順)
    let i1 = 0;
    let j1 = 0;
    let k1 = 0;
    const nonAdjacent: Match[] = [];
    for (const { a: i2, b: j2, size: k2 } of matchingBlocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) {
        k1 += k2;
      } else {
        if (k1) nonAdjacent.push({ a: i1, b: j1, size: k1 });
        i1 = i2;
        j1 = j2;
        k1 = k2;
      }
    }
    if (k1) nonAdjacent.push({ a: i1, b: j1, size: k1 });
    nonAdjacent.push({ a: la, b: lb, size: 0 });

    this.matchingBlocks = nonAdjacent;
    return nonAdjacent;
  }

  /** CPython: SequenceMatcher.ratio */
  ratio(): number {
    const matches = this.getMatchingBlocks().reduce((sum, m) => sum + m.size, 0);
    return calculateRatio(matches, this.a.length + this.b.length);
  }
}

/** CPython: difflib._calculate_ratio */
function calculateRatio(matches: number, length: number): number {
  if (length) return (2.0 * matches) / length;
  return 1.0;
}

/** SequenceMatcher(None, a, b).ratio() 相当のショートカット */
export function sequenceRatio(a: string, b: string): number {
  return new SequenceMatcher(a, b).ratio();
}
