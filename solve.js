// Fast drop-in for makefun-diff 1.0.0 (make.fun's own line diff).
//
// Answers exactly as makefun-diff 1.0.0 on every case, faster. The rule is
// make.fun's: lines are cut after every "\n" (a "\r" is part of its line),
// a last line with no "\n" is a line too, and two lines are equal only when
// they are the same code units. The edit script keeps the common prefix,
// then the common suffix of what is left; between them Myers's greedy
// search from the first lines, keeping on each diagonal the path reaching
// furthest into the old text, the deletion winning when a deletion and an
// insertion reach the same point (jsdiff takes the insertion's), never
// moving past either text's end, pruning no edge diagonal, and following
// every run of equal lines as far as it goes; the first path to reach both
// ends is the script. The patch format is identical to the reference's.
//
// Speed, with no change to the algorithm's semantics or tie-breaking:
//   - Lines are interned to integer ids (one Map lookup per line). Every
//     comparison in the search is then an integer ==, never a string ==.
//   - The Myers search runs on flat Int32Arrays. The V arrays for every
//     depth are kept in one growing Int32Array (triangular layout), and
//     the edit script is recovered by backtracking over them, so the hot
//     loop allocates no objects at all (the reference allocates a path
//     object and a component object per diagonal per depth).
//   - The middle slices are Int32Array copies, so the inner loop indexes
//     them with plain integer offsets.
//   - Output is built in an array of strings and joined once.

/** The patch's first word. */
const FORMAT = 'makefun-diff/1';

/** The kept lines a hunk shows before and after each change run. */
const CONTEXT = 3;

/** Internal run kinds (faster than the patch's '=', '-', '+' strings). */
const KEEP = 0;
const DELETE = 1;
const INSERT = 2;

/**
 * A text's lines as integer ids. Each line is the slice of the text up to
 * and including its "\n" (the last line without one, when the text does
 * not end in one). Equal lines share one id; `strings` maps an id back to
 * the line's text for the patch output.
 */
function internLines(text, map, strings) {
  const ids = [];
  const len = text.length;
  let start = 0;
  while (start < len) {
    const nl = text.indexOf('\n', start);
    const line = nl === -1 ? text.slice(start) : text.slice(start, nl + 1);
    let id = map.get(line);
    if (id === undefined) {
      id = strings.length;
      map.set(line, id);
      strings.push(line);
    }
    ids.push(id);
    if (nl === -1) break;
    start = nl + 1;
  }
  return Int32Array.from(ids);
}

/**
 * The runs of the edit script of oldMid into newMid (Int32Arrays of line
 * ids): [{ kind, count }], in order. Myers's greedy search, exactly the
 * reference's rule, on flat arrays.
 */
function myersRuns(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  // V holds every depth's furthest-x array in one flat Int32Array, laid
  // out triangle by triangle: depth d starts at d*(d+1)/2 and holds d+1
  // entries, diagonal k = 2*j - d at slot j. -1 means "no path". Sized to
  // hold the depths these cases reach without growing again.
  let cap = 1 << 23;
  let V = new Int32Array(cap);
  const ensure = (need) => {
    if (need <= cap) return;
    let nc = cap;
    while (nc < need) nc *= 2;
    const nv = new Int32Array(nc);
    nv.set(V);
    V = nv;
    cap = nc;
  };
  // Depth 0: the initial snake from the first lines.
  let x = 0;
  let y = 0;
  while (x < n && y < m && a[x] === b[y]) {
    x++;
    y++;
  }
  V[0] = x;
  if (x >= n && y >= m) return [{ kind: KEEP, count: x }];
  let D = -1;
  let kFinal = 0;
  for (let d = 1; d <= n + m; d++) {
    const basePrev = ((d - 1) * d) >> 1;
    const baseCurr = (d * (d + 1)) >> 1;
    ensure(baseCurr + d + 1);
    for (let j = 0; j <= d; j++) {
      const k = 2 * j - d;
      // The (d-1) paths this diagonal extends: deletion from k-1, insertion from k+1.
      const xDel = j > 0 ? V[basePrev + j - 1] : -1;
      const xIns = j < d ? V[basePrev + j] : -1;
      const canRemove = xDel >= 0 && xDel < n;
      const canAdd = xIns >= 0 && xIns - 1 - k < m;
      if (!canRemove && !canAdd) {
        V[baseCurr + j] = -1;
        continue;
      }
      // make.fun's tie-break: the candidate further into the old text,
      // and the deletion when both reach the same point.
      const byDel = canRemove ? xDel : -2;
      const byIns = canAdd ? xIns - 1 : -2;
      let xPre;
      if (byDel >= byIns) xPre = xDel + 1;
      else xPre = xIns;
      let yPre = xPre - k;
      let x2 = xPre;
      let y2 = yPre;
      while (x2 < n && y2 < m && a[x2] === b[y2]) {
        x2++;
        y2++;
      }
      V[baseCurr + j] = x2;
      // Only the diagonal k = n - m can reach both ends (there x = n
      // forces y = m), so only there is the end worth testing for.
      if (k === n - m && x2 >= n) {
        D = d;
        kFinal = k;
        break;
      }
    }
    if (D !== -1) break;
  }
  if (D === -1) throw new Error('makefun-diff: the search ended without reaching both ends');
  // Backtrack from (D, kFinal) to the first lines, collecting the edit
  // script in reverse, then reverse it and merge runs of one kind.
  const rev = [];
  let d = D;
  let k = kFinal;
  let cx = n;
  while (d > 0) {
    const j = (k + d) >> 1;
    const basePrev = ((d - 1) * d) >> 1;
    const xDel = j > 0 ? V[basePrev + j - 1] : -1;
    const xIns = j < d ? V[basePrev + j] : -1;
    const canRemove = xDel >= 0 && xDel < n;
    const canAdd = xIns >= 0 && xIns - 1 - k < m;
    const byDel = canRemove ? xDel : -2;
    const byIns = canAdd ? xIns - 1 : -2;
    let isDel;
    let xPre;
    if (byDel >= byIns) {
      isDel = true;
      xPre = xDel + 1;
    } else {
      isDel = false;
      xPre = xIns;
    }
    const snakeLen = cx - xPre;
    if (snakeLen > 0) rev.push({ kind: KEEP, count: snakeLen });
    rev.push({ kind: isDel ? DELETE : INSERT, count: 1 });
    if (isDel) {
      k = k - 1;
      cx = xDel;
    } else {
      k = k + 1;
      cx = xIns;
    }
    d--;
  }
  const x0 = V[0];
  if (x0 > 0) rev.push({ kind: KEEP, count: x0 });
  rev.reverse();
  const runs = [];
  for (const r of rev) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === r.kind) last.count += r.count;
    else runs.push({ kind: r.kind, count: r.count });
  }
  return runs;
}

/** A line as the patch writes it: its op, the line, a newline, and "%" on a line of its own when it had none. */
function written(op, line) {
  return line.endsWith('\n') ? `${op}${line}` : `${op}${line}\n%\n`;
}

/** make.fun's own patch of input.old into input.new. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const map = new Map();
  const strings = [];
  const aIds = internLines(input.old, map, strings);
  const bIds = internLines(input.new, map, strings);
  const n = aIds.length;
  const m = bIds.length;
  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && aIds[prefix] === bIds[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && aIds[n - 1 - suffix] === bIds[m - 1 - suffix]) suffix++;
  const runs = [];
  if (prefix > 0) runs.push({ kind: KEEP, count: prefix });
  runs.push(...myersRuns(aIds.slice(prefix, n - suffix), bIds.slice(prefix, m - suffix)));
  if (suffix > 0) runs.push({ kind: KEEP, count: suffix });

  // The change runs: each a stretch of deletions and insertions between two kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r.kind === KEEP) {
      o += r.count;
      p += r.count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === DELETE) {
      c.dels += r.count;
      o += r.count;
      deleted += r.count;
    } else {
      c.ins += r.count;
      p += r.count;
      inserted += r.count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }
  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written('=', strings[aIds[at]]));
      for (let i = 0; i < c.dels; i++) out.push(written('-', strings[aIds[c.o + i]]));
      for (let i = 0; i < c.ins; i++) out.push(written('+', strings[bIds[c.p + i]]));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written('=', strings[aIds[at]]));
  }
  return out.join('');
}
