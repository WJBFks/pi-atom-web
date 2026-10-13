/**
 * 行内（词级）diff：把「同一行的旧内容 → 新内容」拆成 变更 / 未变更 片段，
 * 让编辑卡片除了整行 +/- 之外，还能看出**具体改了哪几个字段**。
 *
 * 与 pi TUI 的 `dist/modes/interactive/components/diff.js` 同一形态：它在 1 删 + 1 增
 * 时用 `diff` 包的 `diffWords` 做行内对比并把变更段反色。这里不引入依赖，用
 * token 级 LCS（最长公共子序列）自己算，规则对齐 TUI：
 *   - 行首空白不参与高亮（缩进变化不该看起来像改了代码）；
 *   - 只在「删掉的行数 == 新增的行数」时逐行配对（1:1 与 N:N 都对齐），
 *     数量不等时不猜对应关系，整段按原样显示。
 *
 * 纯函数、无 DOM，给单测留出余地。
 */

// 空白段 / 词段 / 单个标点。CJK 逐字落在「单个标点」这一类，因此中文按字为粒度，
// 与 TUI 的 diffWords 对 CJK 的表现一致（不会整句糊成一段）。
const TOKEN_PATTERN = /\s+|[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$]/g;
// LCS 是 O(n·m)；单行极少超过几百个 token，超限就放弃行内高亮（退化成整行 +/-）。
const MAX_TOKENS = 900;

const tokenize = (value) => String(value ?? "").match(TOKEN_PATTERN) || [];

function pushSegment(list, text, changed) {
  const last = list[list.length - 1];
  if (last && last.changed === changed) last.text += text;
  else list.push({ text, changed });
}

/** 行首空白不参与高亮：把首个变更段的前导空白挪回未变更段（对齐 TUI）。 */
function unhighlightLeadingSpace(segments) {
  const first = segments.find((segment) => segment.changed);
  if (!first) return segments;
  const leading = /^\s+/.exec(first.text);
  if (!leading) return segments;
  first.text = first.text.slice(leading[0].length);
  const index = segments.indexOf(first);
  const before = segments[index - 1];
  if (before && !before.changed) before.text += leading[0];
  else segments.splice(index, 0, { text: leading[0], changed: false });
  return segments.filter((segment) => segment.text !== "");
}

/**
 * 词级对比。返回 `{ removed, added }`，每项是 `{ text, changed }[]`：
 * `removed` 是旧行（标出被改掉的部分），`added` 是新行（标出新写上的部分）。
 * 两侧完全相同、或某侧为空、或行太长时返回 null（调用方按整行渲染）。
 */
export function wordSegments(oldText, newText) {
  const a = tokenize(oldText);
  const b = tokenize(newText);
  if (!a.length || !b.length) return null;
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) return null;

  const width = b.length + 1;
  const table = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);

  const removed = [];
  const added = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pushSegment(removed, a[i], false);
      pushSegment(added, b[j], false);
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      pushSegment(removed, a[i], true);
      i += 1;
    } else {
      pushSegment(added, b[j], true);
      j += 1;
    }
  }
  while (i < a.length) pushSegment(removed, a[i++], true);
  while (j < b.length) pushSegment(added, b[j++], true);

  const result = {
    removed: unhighlightLeadingSpace(removed),
    added: unhighlightLeadingSpace(added),
  };
  // 没有任何变更段（例如只是 token 切分等价）时不做行内高亮。
  if (!result.removed.some((segment) => segment.changed)) return null;
  return result;
}

/**
 * 给 `parseToolDiff()` / `editHunks()` 那种 `{ kind, content }` 行数组补行内片段。
 * 返回新数组（不修改入参）；命中配对的行会多出 `segments` 字段。
 */
export function annotateIntraLine(lines) {
  const rows = (lines || []).map((line) => ({ ...line }));
  let index = 0;
  while (index < rows.length) {
    if (rows[index].kind !== "removed") {
      index += 1;
      continue;
    }
    let removedEnd = index;
    while (removedEnd < rows.length && rows[removedEnd].kind === "removed")
      removedEnd += 1;
    let addedEnd = removedEnd;
    while (addedEnd < rows.length && rows[addedEnd].kind === "added")
      addedEnd += 1;
    const removedRows = rows.slice(index, removedEnd);
    const addedRows = rows.slice(removedEnd, addedEnd);
    if (removedRows.length && removedRows.length === addedRows.length)
      removedRows.forEach((line, offset) => {
        const pair = wordSegments(line.content, addedRows[offset].content);
        if (!pair) return;
        line.segments = pair.removed;
        addedRows[offset].segments = pair.added;
      });
    index = addedEnd > index ? addedEnd : removedEnd;
  }
  return rows;
}
