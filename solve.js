// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01).
// Own implementation of the same build, byte for byte, written for CPU time:
// fused Markdown lex+render, chunked inline escaping (no per-character escape),
// front matter parsed without splitting the whole body, fast word counting,
// template precompile per case + render to one output array with
// prototype-chain scopes.
// v2 changes over v1: escapeHtml without a replace callback, template codegen
// with direct single-segment scope reads and a combined escTxt, trimLine with
// no copy when nothing trims, link resolution without copying dirParts per
// link, page toc reuses the renderer's toc entries, card tag links cached
// once per tag.
// No network, no file, no clock, no randomness, no dependencies. Node 22 target.

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  ESC_RE.lastIndex = 0;
  let m = ESC_RE.exec(text);
  if (m === null) return text;
  const out = [];
  let run = 0;
  do {
    const i = m.index;
    if (run < i) out.push(text.slice(run, i));
    const c = text.charCodeAt(i);
    out.push(c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;');
    run = i + 1;
  } while ((m = ESC_RE.exec(text)) !== null);
  if (run < text.length) out.push(text.slice(run));
  return out.join('');
}

const MARK_RE = /\p{M}/gu;
const SLUG_MAX = 64;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), and "untitled" when nothing is left.
 * (After NFKD + mark-strip, toLowerCase only lowers A-Z, matching the reference.)
 */
function slugify(text) {
  let plain = text;
  let nonAscii = false;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { nonAscii = true; break; }
  }
  if (nonAscii) plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = plain.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  let a = 0;
  let b = out.length;
  while (a < b && out.charCodeAt(a) === 45) a++;
  while (b > a && out.charCodeAt(b - 1) === 45) b--;
  out = out.slice(a, b);
  out = out.slice(0, SLUG_MAX);
  let c = out.length;
  while (c > 0 && out.charCodeAt(c - 1) === 45) c--;
  out = out.slice(0, c);
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) { taken.add(slug); return slug; }
  let n = 2;
  let out = `${slug}-2`;
  while (taken.has(out)) { n++; out = `${slug}-${n}`; }
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = date.slice(5, 7);
  const d = date.slice(8, 10);
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Whether a UTF-16 code unit is JS whitespace (the \s set). */
function isWSCode(c) {
  return (
    c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 5760 ||
    (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 ||
    c === 8287 || c === 12288 || c === 65279
  );
}

/** Whitespace table for wordsOf: WS_TABLE[c] is 1 for a JS-whitespace code unit. */
const WS_TABLE = new Uint8Array(65536);
for (const [a, b] of [[9, 13], [32, 32], [160, 160], [5760, 5760], [8192, 8202], [8232, 8233], [8239, 8239], [8287, 8287], [12288, 12288], [65279, 65279]]) WS_TABLE.fill(1, a, b + 1);

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS_TABLE[text.charCodeAt(i)]) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const DATE_ERR = 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw.charCodeAt(i);
      if (c === 92) {
        const n = raw.charCodeAt(i + 1);
        if ((n !== 34 && n !== 92) || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += raw[i + 1];
        i++;
      } else if (c === 34) return { error: 'a quoted string holds a stray quote' };
      else out += raw[i];
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function isAlnumLower(c) {
  return (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return { error: DATE_ERR };
      let y = 0;
      let mo = 0;
      let d = 0;
      for (let i = 0; i < 4; i++) { const c = raw.charCodeAt(i); if (c < 48 || c > 57) return { error: DATE_ERR }; y = y * 10 + (c - 48); }
      for (let i = 5; i < 7; i++) { const c = raw.charCodeAt(i); if (c < 48 || c > 57) return { error: DATE_ERR }; mo = mo * 10 + (c - 48); }
      for (let i = 8; i < 10; i++) { const c = raw.charCodeAt(i); if (c < 48 || c > 57) return { error: DATE_ERR }; d = d * 10 + (c - 48); }
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: DATE_ERR };
      return { value: raw };
    }
    case 'tags': {
      if (raw.length < 2 || raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const parts = inner.split(',');
      const tags = [];
      for (let i = 0; i < parts.length; i++) {
        const t = parts[i].trim();
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        tags.push(t);
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!isAlnumLower(c) && c !== 45) return { error: 'key "layout": not a template name' };
      }
      return raw.length === 0 ? { error: 'key "layout": not a template name' } : { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = false;
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (isAlnumLower(c)) { prevDash = false; continue; }
        if (c === 45 && !prevDash && i !== 0) { prevDash = true; continue; }
        return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  if (text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45) return { error: 'no front matter' };
  if (text.length === 3) return { error: 'the front matter is not closed' };
  if (text.charCodeAt(3) !== 10) return { error: 'no front matter' };
  let closeStart = -1;
  // Start at 3, the '\n' ending the opening line: the close may be line 2
  // ("---\n---\n..."), whose preceding '\n' is exactly that character.
  let pos = 3;
  for (;;) {
    const idx = text.indexOf('\n---', pos);
    if (idx === -1) return { error: 'the front matter is not closed' };
    const after = idx + 4;
    if (after === text.length || text.charCodeAt(after) === 10) { closeStart = idx + 1; break; }
    pos = idx + 1;
  }
  const closeEnd = closeStart + 3;
  const data = {};
  let lineStart = 4;
  let lineNo = 2;
  while (lineStart < closeStart) {
    const lineEnd = text.indexOf('\n', lineStart);
    const line = text.slice(lineStart, lineEnd);
    const L = line.length;
    let p = 0;
    while (p < L && (line.charCodeAt(p) === 32 || line.charCodeAt(p) === 9)) p++;
    if (p !== L && line.charCodeAt(0) !== 35) {
      let k = 0;
      while (k < L) {
        const c = line.charCodeAt(k);
        if ((c >= 97 && c <= 122) || c === 95) k++;
        else break;
      }
      if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${lineNo} is not "key: value"` };
      const key = line.slice(0, k);
      let raw;
      if (k + 1 === L) raw = '';
      else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
      else return { error: `line ${lineNo} is not "key: value"` };
      let r = raw.length;
      while (r > 0) {
        const c = raw.charCodeAt(r - 1);
        if (c === 32 || c === 9) r--;
        else break;
      }
      raw = raw.slice(0, r);
      if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    lineStart = lineEnd + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const body = closeEnd < text.length && text.charCodeAt(closeEnd) === 10 ? text.slice(closeEnd + 1) : '';
  return { data, body };
}

// ---------------------------------------------------------------- markdown

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A line with spaces and tabs at either end dropped (the same string when there is nothing to drop). */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/**
 * A fence's language, or null when `line` does not open one: three backticks and
 * an optional language (A-Z, a-z, 0-9, _, +, -), then spaces or tabs only.
 */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  const L = line.length;
  while (i < L) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < L) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h === 0 || h > 6) return null;
  if (h >= line.length) return null;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  let i = h;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  let j = line.length;
  while (j > i && (line.charCodeAt(j - 1) === 32 || line.charCodeAt(j - 1) === 9)) j--;
  if (j <= i) return null;
  return { depth: h, text: line.slice(i, j) };
}

/** Whether `line` is a thematic break: `---` or `***`, then spaces or tabs only. */
function isHR(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (c0 === 45) {
    if (line.charCodeAt(1) !== 45 || line.charCodeAt(2) !== 45) return false;
  } else if (line.charCodeAt(1) !== 42 || line.charCodeAt(2) !== 42) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A list item's opening: { ordered, start, text }, or null. */
function listOpen(line) {
  const c0 = line.charCodeAt(0);
  if (c0 === 45 || c0 === 42) {
    if (line.charCodeAt(1) === 32) return { ordered: false, start: 1, text: line.slice(2) };
    return null;
  }
  if (c0 >= 48 && c0 <= 57) {
    let i = 0;
    while (i < 9 && i < line.length) {
      const c = line.charCodeAt(i);
      if (c < 48 || c > 57) break;
      i++;
    }
    if (i === 0) return null;
    if (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) return null;
    if (line.charCodeAt(i) === 46 && line.charCodeAt(i + 1) === 32) {
      return { ordered: true, start: Number(line.slice(0, i)), text: line.slice(i + 2) };
    }
    return null;
  }
  return null;
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let i = 2;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i >= line.length) return false;
  return !isWSCode(line.charCodeAt(i));
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a break. */
function endsParagraph(line) {
  const c = line.charCodeAt(0);
  if (c === 96) return fenceLang(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHR(line);
  if (c === 32 || c === 9) return isBlank(line);
  return line.length === 0;
}

/** The characters a backslash escapes. */
function isEscapableCode(c) {
  return (
    c === 92 || c === 96 || c === 42 || c === 95 || c === 91 || c === 93 ||
    c === 40 || c === 41 || c === 35 || c === 43 || c === 45 || c === 46 ||
    c === 33 || c === 62
  );
}

/** The first index from `from` where `s` holds `**` outside a backslash escape, or -1. */
function findDoubleStar(s, from) {
  for (let j = from; j + 1 < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && isEscapableCode(s.charCodeAt(j + 1))) { j++; continue; }
    if (c === 42 && s.charCodeAt(j + 1) === 42) return j;
  }
  return -1;
}

/** The first index from `from` where `s` holds `]` outside a backslash escape, or -1. */
function findCloseBracket(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && isEscapableCode(s.charCodeAt(j + 1))) { j++; continue; }
    if (c === 93) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && isEscapableCode(s.charCodeAt(j + 1))) { j++; continue; }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) { j++; continue; }
    return j;
  }
  return -1;
}

const WS_RE = /\s/;

/** `s` rendered inline; `env.link(target)` is a link's href. */
const JUMP_RE = /[\\`*[&<>"']/g;
/**
 * Renders inline markup by jumping from one special character to the next
 * with a regex (plain runs are copied whole). The regex's lastIndex is set
 * explicitly after every step, so nested (recursive) calls cannot disturb
 * the outer scan.
 */
function inline(s, env) {
  JUMP_RE.lastIndex = 0;
  let out = '';
  let run = 0;
  let m;
  while ((m = JUMP_RE.exec(s)) !== null) {
    const i = m.index;
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < s.length && isEscapableCode(s.charCodeAt(i + 1))) {
        if (run < i) out += s.slice(run, i);
        out += s[i + 1];
        JUMP_RE.lastIndex = i + 2;
        run = i + 2;
        continue;
      }
      JUMP_RE.lastIndex = i + 1;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (run < i) out += s.slice(run, i);
        out += '<code>' + escapeHtml(s.slice(i + 1, j)) + '</code>';
        JUMP_RE.lastIndex = j + 1;
        run = j + 1;
        continue;
      }
      JUMP_RE.lastIndex = i + 1;
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findDoubleStar(s, i + 2);
        if (j > i + 2) {
          if (run < i) out += s.slice(run, i);
          out += '<strong>' + inline(s.slice(i + 2, j), env) + '</strong>';
          JUMP_RE.lastIndex = j + 2;
          run = j + 2;
          continue;
        }
        JUMP_RE.lastIndex = i + 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (run < i) out += s.slice(run, i);
        out += '<em>' + inline(s.slice(i + 1, j), env) + '</em>';
        JUMP_RE.lastIndex = j + 1;
        run = j + 1;
        continue;
      }
      JUMP_RE.lastIndex = i + 1;
      continue;
    }
    if (c === 91) {
      const k = findCloseBracket(s, i + 1);
      const mm = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !WS_RE.test(target)) {
        if (run < i) out += s.slice(run, i);
        out += '<a href="' + escapeHtml(env.link(target)) + '">' + inline(s.slice(i + 1, k), env) + '</a>';
        JUMP_RE.lastIndex = mm + 1;
        run = mm + 1;
        continue;
      }
      JUMP_RE.lastIndex = i + 1;
      continue;
    }
    if (run < i) out += s.slice(run, i);
    out += c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;';
    run = i + 1;
    JUMP_RE.lastIndex = i + 1;
  }
  if (run < s.length) out += s.slice(run);
  return out;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last),
 * its table of contents (every level 2 and 3 heading: level, id and its inline
 * HTML), its excerpt (the first paragraph's inline HTML, or ""), and its word
 * HTML) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const N = src.length;
  let pos = 0;
  const nextLine = () => {
    if (pos >= N) return null;
    const nl = src.indexOf('\n', pos);
    if (nl === -1) {
      const line = src.slice(pos);
      pos = N;
      return line;
    }
    const line = src.slice(pos, nl);
    pos = nl + 1;
    return line;
  };
  let line = nextLine();
  // Renders a list starting at `first` (its opening line); consumes the lines
  // that belong to it and leaves `line` at the first line after the list.
  const renderList = (first) => {
    const items = [[trimLine(first.text)]];
    line = nextLine();
    while (line !== null) {
      const m = listOpen(line);
      if (m !== null && m.ordered === first.ordered) {
        items.push([trimLine(m.text)]);
        line = nextLine();
      } else if (isContinued(line)) {
        items[items.length - 1].push(trimLine(line));
        line = nextLine();
      } else break;
    }
    const tag = first.ordered ? 'ol' : 'ul';
    const open = first.ordered && first.start !== 1 ? `<ol start="${first.start}">` : `<${tag}>`;
    let inner = '';
    for (let q = 0; q < items.length; q++) inner += `<li>${inline(items[q].join('\n'), env)}</li>\n`;
    return `${open}\n${inner}</${tag}>`;
  };
  while (line !== null) {
    const c0 = line.length === 0 ? -1 : line.charCodeAt(0);
    if (c0 === 32 || c0 === 9 || c0 === -1) {
      if (isBlank(line)) {
        line = nextLine();
        continue;
      }
    } else if (c0 === 96) {
      const lang = fenceLang(line);
      if (lang !== null) {
        const body = [];
        line = nextLine();
        while (line !== null && !isFenceClose(line)) {
          body.push(line);
          line = nextLine();
        }
        if (line !== null) line = nextLine();
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
        const code = body.length === 0 ? '' : escapeHtml(body.join('\n')) + '\n';
        blocks.push(`<pre><code${cls}>${code}</code></pre>`);
        continue;
      }
    } else if (c0 === 35) {
      const hd = headingOf(line);
      if (hd !== null) {
        const id = uniqueSlug(slugify(hd.text), ids);
        const html = inline(hd.text, env);
        blocks.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>`);
        if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
        line = nextLine();
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHR(line)) {
        blocks.push('<hr>');
        line = nextLine();
        continue;
      }
      const li = listOpen(line);
      if (li !== null) {
        blocks.push(renderList(li));
        continue;
      }
    } else if (c0 === 62) {
      const qlines = [];
      while (line !== null && line.charCodeAt(0) === 62) {
        let t = line.slice(1);
        if (t.charCodeAt(0) === 32) t = t.slice(1);
        t = trimLine(t);
        if (t !== '') qlines.push(t);
        line = nextLine();
      }
      blocks.push(qlines.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(qlines.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const li = listOpen(line);
      if (li !== null) {
        blocks.push(renderList(li));
        continue;
      }
    }
    const plines = [trimLine(line)];
    line = nextLine();
    while (line !== null && !endsParagraph(line)) {
      plines.push(trimLine(line));
      line = nextLine();
    }
    const html = inline(plines.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let v = scope[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** `textOf(v)` escaped: numbers and booleans never hold an escapable character. */
function escTxt(v) {
  if (typeof v === 'string') return escapeHtml(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return escapeHtml(v.map(textOf).join(', '));
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `out` (an array of pieces) in `scope` (a prototype chain
 * of null-prototype objects). `ctx` holds the parsed templates and the escape.
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = Object.create(scope);
          vars[n.name] = xs[k];
          vars.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
          renderNodes(n.body, vars, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- template codegen
//
// Each parsed template is compiled once per case into a function
// fn(S, D, O): S is the scope (prototype chain), D the include depth, O the
// shared output array. Code is generated from the node tree, so rendering is
// straight-line pushes with inlined lookups instead of a tree walk. A template
// whose output depends only on the case-wide values (site, tags, recent) is
// rendered once per case and depth and reused (see computeCacheable).
// If code generation is ever unavailable, renderNodes above is the fallback.

/** Render the template `name` from map `F` into `O`, or nothing when missing. */
function tplInc(F, name, S, D, O) {
  const fn = F.get(name);
  if (fn !== undefined) fn(S, D, O);
}

/** Like tplInc, but the template's output is cached per (name, depth). */
function tplIncCached(C, F, name, S, D, O) {
  const fn = F.get(name);
  if (fn === undefined) return;
  const k = name + '/' + D;
  let c = C[k];
  if (c === undefined) {
    const t = [];
    fn(S, D, t);
    c = t.join('');
    C[k] = c;
  }
  O.push(c);
}

/** Compile one parsed template into fn(S, D, O). `F` is the case's map of
 * compiled templates (filled as compilation proceeds; looked up only at
 * render time) and `C` its include cache. */
function compileTemplate(nodes, cacheable, F, C) {
  const paths = [];
  const pathIndex = new Map();
  const pid = (path) => {
    const k = path.join('\u0000');
    let i = pathIndex.get(k);
    if (i === undefined) {
      i = paths.length;
      pathIndex.set(k, i);
      paths.push(path);
    }
    return i;
  };
  let tmp = 0;
  let scopeDepth = 0;
  // A one-segment path reads straight off the scope (prototype chain included),
  // exactly as lookup does for it; longer paths still go through lookup.
  const ref = (scopeVar, path) => (path.length === 1 ? `${scopeVar}[${JSON.stringify(path[0])}]` : `get(${scopeVar},P[${pid(path)}])`);
  const gen = (ns, scopeVar) => {
    let code = '';
    for (let ni = 0; ni < ns.length; ni++) {
      const n = ns[ni];
      if (n.kind === 'text') code += `O.push(${JSON.stringify(n.text)});\n`;
      else if (n.kind === 'var') code += `O.push(escTxt(${ref(scopeVar, n.path)}));\n`;
      else if (n.kind === 'raw') code += `O.push(txt(${ref(scopeVar, n.path)}));\n`;
      else if (n.kind === 'if') {
        const cond = n.not
          ? `!truthy(${ref(scopeVar, n.path)})`
          : `truthy(${ref(scopeVar, n.path)})`;
        code += `if (${cond}) {\n${gen(n.then, scopeVar)}}`;
        if (n.else !== null) code += ` else {\n${gen(n.else, scopeVar)}}`;
        code += `\n`;
      } else if (n.kind === 'for') {
        const x = `_x${tmp}`;
        const k = `_k${tmp}`;
        const sv = `S${++scopeDepth}`;
        tmp++;
        code += `{var ${x}=${ref(scopeVar, n.path)};if(Array.isArray(${x})){for(var ${k}=0;${k}<${x}.length;${k}++){var ${sv}=Object.create(${scopeVar});${sv}.${n.name}=${x}[${k}];${sv}.loop={index:${k}+1,first:${k}===0,last:${k}===${x}.length-1,length:${x}.length};\n${gen(n.body, sv)}}}}\n`;
        scopeDepth--;
      } else if (n.kind === 'include') {
        if (cacheable.has(n.name)) code += `if(D<8)incC(C,F,${JSON.stringify(n.name)},${scopeVar},D+1,O);\n`;
        else code += `if(D<8)inc(F,${JSON.stringify(n.name)},${scopeVar},D+1,O);\n`;
      }
    }
    return code;
  };
  const body = gen(nodes, 'S');
  const factory = new Function(
    'F', 'C', 'get', 'txt', 'truthy', 'escTxt', 'inc', 'incC', 'P',
    `return function(S,D,O){\n${body}}`,
  );
  return factory(F, C, lookup, textOf, truthy, escTxt, tplInc, tplIncCached, paths);
}

/**
 * A template's free root names: the names it reads that no loop of its own
 * binds, plus, transitively, those of every template it includes (a
 * conservative over-approximation: names bound at an include site are not
 * subtracted). Also collects every loop variable name in the case.
 */
function computeNeeds(templates) {
  const needs = new Map();
  const includes = new Map();
  const loopVars = new Set();
  for (const [name, nodes] of templates) {
    const s = new Set();
    const incs = [];
    const walk = (ns, bound) => {
      for (let ni = 0; ni < ns.length; ni++) {
        const n = ns[ni];
        if (n.kind === 'var' || n.kind === 'raw' || n.kind === 'if') {
          if (!bound.has(n.path[0])) s.add(n.path[0]);
          if (n.kind === 'if') {
            walk(n.then, bound);
            if (n.else) walk(n.else, bound);
          }
        } else if (n.kind === 'for') {
          if (!bound.has(n.path[0])) s.add(n.path[0]);
          loopVars.add(n.name);
          const b2 = new Set(bound);
          b2.add(n.name);
          b2.add('loop');
          walk(n.body, b2);
        } else if (n.kind === 'include') incs.push(n.name);
      }
    };
    walk(nodes, new Set());
    needs.set(name, s);
    includes.set(name, incs);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, incs] of includes) {
      const s = needs.get(name);
      for (let i = 0; i < incs.length; i++) {
        const nu = needs.get(incs[i]);
        if (!nu) continue;
        for (const r of nu) {
          if (!s.has(r)) {
            s.add(r);
            changed = true;
          }
        }
      }
    }
  }
  return { needs, loopVars };
}

const GLOBALS = new Set(['site', 'tags', 'recent']);

/**
 * Which templates are safe to render once per case and depth: their output
 * depends only on site, tags and recent (never on a page, a list or a loop
 * variable bound outside them). Caching is disabled outright when any loop
 * variable anywhere is named site, tags or recent, since such a loop could
 * shadow the globals at an include site.
 */
function computeCacheable(templates) {
  const { needs, loopVars } = computeNeeds(templates);
  if ([...loopVars].some((v) => GLOBALS.has(v))) return new Set();
  const out = new Set();
  for (const [name, s] of needs) {
    let ok = true;
    for (const r of s) {
      if (!GLOBALS.has(r)) {
        ok = false;
        break;
      }
    }
    if (ok) out.add(name);
  }
  return out;
}

/**
 * Which templates are safe to memoize by one variable: their output depends
 * only on the case-wide values plus a single object (their one non-global
 * free name). Returns a Map from template name to that variable's name.
 * A template whose single free name is shadowed by a loop anywhere is still
 * safe: the memo key is the object the name resolves to at the include site.
 */
function computeMemoizable(templates) {
  const { needs } = computeNeeds(templates);
  const out = new Map();
  for (const [name, s] of needs) {
    let single = null;
    let ok = true;
    for (const r of s) {
      if (GLOBALS.has(r)) continue;
      if (single === null) single = r;
      else if (single !== r) {
        ok = false;
        break;
      }
    }
    if (ok && single !== null) out.set(name, single);
  }
  return out;
}

/**
 * Wrap a compiled template so its render is memoized by the object its one
 * free variable resolves to (and the include depth). The wrapped function
 * renders into a scratch array on a miss and reuses the joined string after.
 */
function memoizeTemplate(fn, varName) {
  const cache = new WeakMap();
  return function (S, D, O) {
    const v = S[varName];
    if (v !== null && typeof v === 'object') {
      let byDepth = cache.get(v);
      if (byDepth === undefined) {
        byDepth = new Map();
        cache.set(v, byDepth);
      }
      let s = byDepth.get(D);
      if (s === undefined) {
        const t = [];
        fn(S, D, t);
        s = t.join('');
        byDepth.set(D, s);
      }
      O.push(s);
      return;
    }
    fn(S, D, O);
  };
}

/** Compile every parsed template of a case, or null when codegen fails. */
function compileAll(templates) {
  try {
    const cacheable = computeCacheable(templates);
    const memoizable = computeMemoizable(templates);
    const F = new Map();
    const C = Object.create(null);
    for (const [name, nodes] of templates) F.set(name, compileTemplate(nodes, cacheable, F, C));
    for (const [name, varName] of memoizable) {
      const fn = F.get(name);
      if (fn !== undefined) F.set(name, memoizeTemplate(fn, varName));
    }
    return { F, C };
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------- build

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory parts `dirParts`, or null when it climbs out of the root. */
function resolvePath(dirParts, rel) {
  const parts = dirParts.slice();
  let i = 0;
  const n = rel.length;
  while (i < n) {
    let j = rel.indexOf('/', i);
    if (j === -1) j = n;
    const seg = rel.slice(i, j);
    if (seg === '' || seg === '.') {
      // skip
    } else if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
    i = j + 1;
  }
  return parts.join('/');
}

/** `resolvePath` without the copy: `rel` has no "..", no "//", no leading "." and no "/." segment, so it appends plainly. */
function resolvePathFast(dirParts, dirPrefix, rel) {
  if (rel.indexOf('..') === -1 && rel.indexOf('//') === -1 && rel.charCodeAt(0) !== 46 && rel.indexOf('/.') === -1) {
    return dirPrefix + rel;
  }
  return resolvePath(dirParts, rel);
}

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** One site's output tree: path -> text. */
function build(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const sources = [];
  const statics = [];
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi];
    if (f.path.endsWith('.md')) {
      let text = f.content;
      if (text.indexOf('\r') !== -1) text = text.replace(/\r\n?/g, '\n');
      const srcDir = dirOf(f.path);
      sources.push({ path: f.path, text, srcDir, dirParts: srcDir === '' ? [] : srcDir.split('/') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (let si = 0; si < sources.length; si++) {
    const s = sources[si];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (let si = 0; si < kept.length; si++) {
    const s = kept[si];
    const dir = s.post ? 'posts' : s.srcDir;
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set();
  for (let fi = 0; fi < statics.length; fi++) staticPaths.add(statics[fi].path);
  const broken = new Set();
  const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
  for (let si = 0; si < kept.length; si++) {
    const s = kept[si];
    const dirParts = s.dirParts;
    const dirPrefix = dirParts.length === 0 ? '' : dirParts.join('/') + '/';
    const srcPath = s.path;
    const env = {
      link: (target) => {
        if (SCHEME_RE.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePathFast(dirParts, dirPrefix, rel);
        if (path !== null) {
          const page = bySource.get(path);
          if (page !== undefined) return `${page.url}${frag}`;
          if (staticPaths.has(path)) return `${base}/${path}${frag}`;
        }
        broken.add(`broken-link ${srcPath} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  // Tag names repeat across posts; their slugs are cached.
  const tagSlugCache = new Map();
  const tagSlug = (name) => {
    let s = tagSlugCache.get(name);
    if (s === undefined) {
      s = slugify(name);
      tagSlugCache.set(name, s);
    }
    return s;
  };
  const bySlug = new Map();
  for (let pi = 0; pi < posts.length; pi++) {
    const p = posts[pi];
    p.tagRefs = [];
    const seen = new Set();
    const names = p.data.tags ?? [];
    for (let ti = 0; ti < names.length; ti++) {
      const name = names[ti];
      const slug = tagSlug(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        tag.link = { name, slug, url: tag.url };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let si = 0; si < kept.length; si++) {
    const s = kept[si];
    if (s.post) continue;
    s.tagRefs = [];
    const seen = new Set();
    const names = s.data.tags ?? [];
    for (let ti = 0; ti < names.length; ti++) {
      const name = names[ti];
      const slug = tagSlug(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      s.tagRefs.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // A post's card, as lists show it; a page as its layout reads it.
  for (let si = 0; si < kept.length; si++) {
    const s = kept[si];
    const card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => t.link ?? { name: t.name, slug: t.slug, url: t.url }),
    };
    s.card = card;
    s.page = {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  }

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const compiled = compileAll(templates);
  const ctx = { templates };
  // One root scope per case, reused across renders: the render-specific keys
  // are (re)assigned each time, so no stale value can leak between renders.
  // Assigning undefined is the same as the key being absent (lookup reads
  // the value, and the values here are never undefined when present).
  const scope = Object.create(null);
  scope.site = site;
  scope.tags = allTags;
  scope.recent = recent;
  const render = (name, vars) => {
    scope.page = vars.page;
    scope.posts = vars.posts;
    scope.pager = vars.pager;
    scope.tag = vars.tag;
    const out = [];
    if (compiled !== null) {
      const fn = compiled.F.get(name);
      if (fn === undefined) return null;
      fn(scope, 0, out);
    } else {
      const nodes = templates.get(name);
      if (nodes === undefined) return null;
      renderNodes(nodes, scope, ctx, 0, out);
    }
    return out.join('');
  };
  const output = {};
  for (let si = 0; si < kept.length; si++) {
    const s = kept[si];
    output[`${s.outDir}/index.html`] = render(s.layout, { page: s.page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (let ti = 0; ti < tags.length; ti++) {
    const t = tags[ti];
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let fi = 0; fi < statics.length; fi++) {
    const f = statics[fi];
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (let si = 0; si < kept.length; si++) if (!kept[si].post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
