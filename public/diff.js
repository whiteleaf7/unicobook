// 前回読んだときの本文と比べて、変わった行を見つける。
// 本文そのものは保存せず、行ごとの指紋（32bit のハッシュ）だけを比べる

export function lineHashes(lines) {
  return lines.map((line) => {
    // FNV-1a
    let h = 0x811c9dc5;
    for (let i = 0; i < line.length; i++) {
      h ^= line.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  });
}

// これ以上変更が多いときは、最初に違う行から後ろを全部変更とみなす（比較の時間と記憶を抑えるため）
const MAX_EDITS = 2000;

// 新しい本文の行番号のうち、追加・書き換えられた行と、行が削除された直後の行を返す。
// hunks は連続した変更のまとまりごとの先頭の行番号
export function changedLines(before, after) {
  const changed = new Set();
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endA = before.length;
  let endB = after.length;
  while (endA > start && endB > start && before[endA - 1] === after[endB - 1]) {
    endA--;
    endB--;
  }
  const a = before.slice(start, endA);
  const b = after.slice(start, endB);
  const mark = (i) => changed.add(Math.min(start + i, after.length - 1));

  const edits = myers(a, b);
  if (edits) {
    for (const e of edits) mark(e);
  } else {
    for (let i = 0; i < Math.max(b.length, 1); i++) mark(i);
  }
  if (after.length === 0) changed.clear();
  return { changed, hunks: toHunks(changed) };
}

// Myers の差分。b の行番号のうち、挿入された行と、a の行が削除された位置を返す
function myers(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, offset, n, m);
    }
  }
  return null;
}

function backtrack(trace, offset, n, m) {
  const edits = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
    }
    // 下へ進んだなら b の行の挿入、右へ進んだなら a の行の削除（b では y の位置）
    edits.push(x === prevX ? prevY : y);
    x = prevX;
    y = prevY;
  }
  return edits;
}

function toHunks(changed) {
  const sorted = [...changed].sort((p, q) => p - q);
  return sorted.filter((line, i) => i === 0 || line - sorted[i - 1] > 1);
}

// 変更前（beforeLines）と変更後（afterLines）を比較し、
// ハンク（変更ブロック）ごとの { line, deleted: string[], added: string[] } の配列を返す
export function detailedDiff(before, after) {
  const n = before.length;
  const m = after.length;
  if (n === 0 && m === 0) return [];
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = false;

  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && before[x] === after[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
    if (found) break;
  }

  if (!found) {
    // 変更が多すぎる場合は全体を 1 つの置換ハンクとする
    return [{ line: 0, deleted: [...before], added: [...after] }];
  }

  // trace を辿って各行の操作 (equal / delete / insert) を復元
  const ops = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const vt = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vt[offset + k - 1] < vt[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = vt[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: 'equal', text: before[x - 1], lineB: y - 1 });
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push({ type: 'insert', text: after[y - 1], lineB: y - 1 });
      y--;
    } else {
      ops.push({ type: 'delete', text: before[x - 1], lineB: y });
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ type: 'equal', text: before[x - 1], lineB: y - 1 });
    x--;
    y--;
  }
  while (x > 0) {
    ops.push({ type: 'delete', text: before[x - 1], lineB: 0 });
    x--;
  }
  while (y > 0) {
    ops.push({ type: 'insert', text: after[y - 1], lineB: y - 1 });
    y--;
  }
  ops.reverse();

  const hunks = [];
  let cur = null;
  for (const op of ops) {
    if (op.type === 'equal') {
      if (cur) {
        hunks.push(cur);
        cur = null;
      }
    } else {
      cur ??= { line: op.lineB, deleted: [], added: [] };
      if (op.type === 'delete') cur.deleted.push(op.text);
      if (op.type === 'insert') cur.added.push(op.text);
    }
  }
  if (cur) hunks.push(cur);
  return hunks;
}

// 2 つの文字列（行内のテキスト等）を文字単位で比較し、
// before 用（equal / delete）と after 用（equal / insert）のトークン配列を返す
export function diffChars(beforeStr, afterStr) {
  if (beforeStr === afterStr) {
    return {
      before: beforeStr ? [{ type: 'equal', text: beforeStr }] : [],
      after: afterStr ? [{ type: 'equal', text: afterStr }] : [],
    };
  }
  if (!beforeStr) {
    return {
      before: [],
      after: afterStr ? [{ type: 'insert', text: afterStr }] : [],
    };
  }
  if (!afterStr) {
    return {
      before: [{ type: 'delete', text: beforeStr }],
      after: [],
    };
  }

  const a = [...beforeStr];
  const b = [...afterStr];

  // 前後の共通部分を抽出（プレフィックス & サフィックス）
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const prefix = a.slice(0, start).join('');
  const suffix = a.slice(endA).join('');

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  const n = midA.length;
  const m = midB.length;

  let midOps = [];
  if (n === 0) {
    midOps = [{ type: 'insert', text: midB.join('') }];
  } else if (m === 0) {
    midOps = [{ type: 'delete', text: midA.join('') }];
  } else {
    // midA と midB で Myers の差分を計算
    const max = n + m;
    const offset = max + 1;
    const v = new Int32Array(2 * max + 3);
    const trace = [];
    let found = false;

    for (let d = 0; d <= max; d++) {
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && midA[x] === midB[y]) {
          x++;
          y++;
        }
        v[offset + k] = x;
        if (x >= n && y >= m) {
          found = true;
          break;
        }
      }
      if (found) break;
    }

    if (!found) {
      midOps = [
        { type: 'delete', text: midA.join('') },
        { type: 'insert', text: midB.join('') },
      ];
    } else {
      let x = n;
      let y = m;
      for (let d = trace.length - 1; d > 0; d--) {
        const vt = trace[d];
        const k = x - y;
        const prevK = k === -d || (k !== d && vt[offset + k - 1] < vt[offset + k + 1]) ? k + 1 : k - 1;
        const prevX = vt[offset + prevK];
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) {
          midOps.push({ type: 'equal', text: midA[x - 1] });
          x--;
          y--;
        }
        if (x === prevX) {
          midOps.push({ type: 'insert', text: midB[y - 1] });
          y--;
        } else {
          midOps.push({ type: 'delete', text: midA[x - 1] });
          x--;
        }
      }
      while (x > 0 && y > 0) {
        midOps.push({ type: 'equal', text: midA[x - 1] });
        x--;
        y--;
      }
      while (x > 0) {
        midOps.push({ type: 'delete', text: midA[x - 1] });
        x--;
      }
      while (y > 0) {
        midOps.push({ type: 'insert', text: midB[y - 1] });
        y--;
      }
      midOps.reverse();
    }
  }

  // プレフィックス、ミドル、サフィックスを組み立て
  const beforeParts = [];
  const afterParts = [];

  if (prefix) {
    beforeParts.push({ type: 'equal', text: prefix });
    afterParts.push({ type: 'equal', text: prefix });
  }

  for (const op of midOps) {
    if (op.type === 'equal') {
      appendMerged(beforeParts, 'equal', op.text);
      appendMerged(afterParts, 'equal', op.text);
    } else if (op.type === 'delete') {
      appendMerged(beforeParts, 'delete', op.text);
    } else if (op.type === 'insert') {
      appendMerged(afterParts, 'insert', op.text);
    }
  }

  if (suffix) {
    appendMerged(beforeParts, 'equal', suffix);
    appendMerged(afterParts, 'equal', suffix);
  }

  return { before: beforeParts, after: afterParts };
}

function appendMerged(arr, type, char) {
  if (arr.length > 0 && arr[arr.length - 1].type === type) {
    arr[arr.length - 1].text += char;
  } else {
    arr.push({ type, text: char });
  }
}
