// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// Written from scratch against the vendor README and the reference
// semantics: run(input) returns the same output tree, byte for byte, for
// every input. No vendor code is included or imported here; only the
// observable behaviour is reproduced.
//
// v2 changes over v1 (same output, byte for byte):
//  - inline(): the special-scan regex also stops at & < > " ', and the
//    entities are emitted in the main loop, so plain runs are copied
//    without an esc() call and a second regex scan per run.
//  - reading minutes: words are counted straight over the source lines
//    (no s.body join, no per-character function call); a line break is
//    whitespace, so the count is identical.
//  - endsPara(): a first-character dispatch skips the three classifier
//    calls for lines that cannot end a paragraph.
//
// All state lives inside run(): nothing is cached from one case to the
// next, and the module holds no mutable state, so repeated runs are
// deterministic.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ESCAPABLES = '\\`*_[]()#+-.!>';
const RESERVED = ['posts', 'tags', 'page'];

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function isWsCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 0xa0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

function hasWs(s) {
  for (let i = 0; i < s.length; i++) if (isWsCode(s.charCodeAt(i))) return true;
  return false;
}

/** HTML escaping: & < > " ' and nothing else. Fast path when none occur. */
function esc(s) {
  if (!/[&<>"']/.test(s)) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    let rep = null;
    if (c === '&') rep = '&amp;';
    else if (c === '<') rep = '&lt;';
    else if (c === '>') rep = '&gt;';
    else if (c === '"') rep = '&quot;';
    else if (c === "'") rep = '&#39;';
    else continue;
    if (i > start) out += s.slice(start, i);
    out += rep;
    start = i + 1;
  }
  if (start < s.length) out += s.slice(start);
  return out;
}

/** The slug of `text`, exactly as the reference defines it. */
function slugifyRaw(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  // ASCII text is unchanged by NFKD and holds no combining marks, so the
  // normalise + mark-strip step can be skipped for it.
  const plain = ascii ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  if (out.length > 64) out = out.slice(0, 64);
  while (out.endsWith('-')) out = out.slice(0, -1);
  return out === '' ? 'untitled' : out;
}

function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const out = slugifyRaw(text);
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function stripTrailingSlashes(s) {
  let e = s.length;
  while (e > 0 && s.charCodeAt(e - 1) === 47) e--;
  return s.slice(0, e);
}

/** Whitespace table: exactly the JS \s set (see isWsCode). */
const WS_TABLE = (() => {
  const t = new Uint8Array(65536);
  for (const c of [32, 9, 10, 11, 12, 13, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) t[c] = 1;
  for (let c = 0x2000; c <= 0x200a; c++) t[c] = 1;
  return t;
})();

/** Words in lines[start..], counted straight over the lines: a line break
 * is whitespace, so the total equals wordsOf(lines.join('\n')) exactly,
 * without building the joined body string. */
function wordsOfLines(lines, start) {
  let n = 0;
  for (let li = start; li < lines.length; li++) {
    const s = lines[li];
    let inWord = false;
    for (let i = 0; i < s.length; i++) {
      if (WS_TABLE[s.charCodeAt(i)]) inWord = false;
      else if (!inWord) { inWord = true; n++; }
    }
  }
  return n;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir` of a source, or null when it climbs out. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- front matter

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function stripTrailingST(s) {
  let e = s.length;
  while (e > 0) {
    const c = s.charCodeAt(e - 1);
    if (c === 32 || c === 9) e--;
    else break;
  }
  return s.slice(0, e);
}

function isKeyName(key) {
  if (key.length === 0) return false;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || c === 95)) return false;
  }
  return true;
}

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: "a quoted string holds an escape other than \\\" or \\\\" };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function tagOk(t) {
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '"' || c === '[' || c === ']') return false;
  }
  return true;
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      if (s.error) return { error: `key "${key}": ${s.error}` };
      return s;
    }
    case 'date': {
      // A date is exactly ten characters: four digits, '-', two digits,
      // '-', two digits — the reference's /^(\d{4})-(\d{2})-(\d{2})$/.
      // Every position is checked by hand: '-' at 4 and 7, digits elsewhere.
      let shape = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (shape) {
        for (let p = 0; p < 10; p++) {
          if (p === 4 || p === 7) continue;
          const code = raw.charCodeAt(p);
          if (code < 48 || code > 57) { shape = false; break; }
        }
      }
      const year = shape ? Number(raw.slice(0, 4)) : 0;
      const month = shape ? Number(raw.slice(5, 7)) : 0;
      const day = shape ? Number(raw.slice(8, 10)) : 0;
      const inRange = shape && year >= 1970 && year <= 2099 && month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month);
      if (!inRange) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || !tagOk(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** A source's front matter and close line: { data, close }, or { error }. */
function parseFM(lines) {
  if (lines.length === 0 || lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlankLine(line) || line.charCodeAt(0) === 35) continue;
    const ci = line.indexOf(':');
    if (ci === -1) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, ci);
    if (!isKeyName(key)) return { error: `line ${i + 1} is not "key: value"` };
    let raw;
    if (ci + 1 === line.length) raw = '';
    else if (line.charCodeAt(ci + 1) === 32) raw = line.slice(ci + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    raw = stripTrailingST(raw);
    if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if (v.error) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, close };
}

// ---------------------------------------------------------------- Markdown

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/** A fence-open line's language, or null when the line is not one. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length && isLangChar(line.charCodeAt(i))) i++;
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null. */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n < 1 || n > 6) return null;
  if (n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let a = n;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === a) return null;
  return { depth: n, text: line.slice(a, b) };
}

function isHr(line) {
  if (line.length < 3) return false;
  const a = line.charCodeAt(0);
  const b = line.charCodeAt(1);
  const c = line.charCodeAt(2);
  if (!((a === 45 && b === 45 && c === 45) || (a === 42 && b === 42 && c === 42))) return false;
  for (let i = 3; i < line.length; i++) {
    const d = line.charCodeAt(i);
    if (d !== 32 && d !== 9) return false;
  }
  return true;
}

function isContinued(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 32) k++;
  if (k < 2 || k >= line.length) return false;
  return !isWsCode(line.charCodeAt(k));
}

function bulletMarker(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

function orderedMarker(line) {
  let d = 0;
  while (d < line.length && d < 9) {
    const c = line.charCodeAt(d);
    if (c < 48 || c > 57) break;
    d++;
  }
  if (d < 1) return null;
  if (line.charCodeAt(d) !== 46 || line.charCodeAt(d + 1) !== 32) return null;
  return { start: Number(line.slice(0, d)), text: line.slice(d + 2) };
}

function listFirst(line) {
  const b = bulletMarker(line);
  if (b !== null) return { ordered: false, text: b };
  const o = orderedMarker(line);
  if (o !== null) return { ordered: true, start: o.start, text: o.text };
  return null;
}

function endsPara(line) {
  // Only a blank line, a fence, a heading or an HR ends a paragraph, and
  // each of those starts with ' ', '\t', '`', '#' , '-' or '*'; any other
  // first character settles it with one check.
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c !== 32 && c !== 9 && c !== 96 && c !== 35 && c !== 45 && c !== 42) return false;
  return isBlankLine(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

/** The first index from `from` where `s` holds `what` outside an escape, or -1. */
function findUnescaped(s, what, from) {
  const wl = what.length;
  for (let j = from; j <= s.length - wl; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLES.indexOf(s[j + 1]) !== -1) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLES.indexOf(s[j + 1]) !== -1) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The next inline special (`\`, backtick, '*', '[') or HTML-escapable
 * ('&', '<', '>', '"', ''') from a position, or null. One scan instead of
 * four indexOf passes plus a separate esc() scan per plain run: a plain
 * run between two hits holds no escapable, so it is copied as-is, and an
 * escapable is emitted as its entity in the main loop. The regex is
 * module-level and its lastIndex is set before every exec, so the
 * recursive inline calls below cannot corrupt it. */
const SPECIAL_RE = /[\\`*\[&<>"']/g;

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  let out = '';
  const n = s.length;
  let i = 0;
  while (i < n) {
    // Jump straight to the next special character instead of walking
    // every character: plain runs hold no escapable, so they are copied
    // as whole slices without an esc() call.
    SPECIAL_RE.lastIndex = i;
    const hit = SPECIAL_RE.exec(s);
    const j = hit === null ? n : hit.index;
    if (j === n) {
      out += s.slice(i);
      break;
    }
    if (j > i) out += s.slice(i, j);
    const jc = s.charCodeAt(j);
    if (jc === 38) { out += '&amp;'; i = j + 1; continue; }
    if (jc === 60) { out += '&lt;'; i = j + 1; continue; }
    if (jc === 62) { out += '&gt;'; i = j + 1; continue; }
    if (jc === 34) { out += '&quot;'; i = j + 1; continue; }
    if (jc === 39) { out += '&#39;'; i = j + 1; continue; }
    if (jc === 92) {
      if (j + 1 < n && ESCAPABLES.indexOf(s[j + 1]) !== -1) {
        // The escaped character is itself escaped ('\>' -> '&gt;'), and '>'
        // is the only escapable character the HTML escaper touches.
        out += s[j + 1] === '>' ? '&gt;' : s[j + 1];
        i = j + 2;
      } else {
        out += '\\';
        i = j + 1;
      }
      continue;
    }
    if (jc === 96) {
      const m = s.indexOf('`', j + 1);
      if (m > j + 1) {
        out += '<code>';
        out += esc(s.slice(j + 1, m));
        out += '</code>';
        i = m + 1;
      } else {
        out += '`';
        i = j + 1;
      }
      continue;
    }
    if (jc === 42) {
      if (s.charCodeAt(j + 1) === 42) {
        const m = findUnescaped(s, '**', j + 2);
        if (m > j + 2) {
          out += '<strong>';
          out += inline(s.slice(j + 2, m), env);
          out += '</strong>';
          i = m + 2;
        } else {
          out += '**';
          i = j + 2;
        }
      } else {
        const m = findSingleStar(s, j + 1);
        if (m > j + 1) {
          out += '<em>';
          out += inline(s.slice(j + 1, m), env);
          out += '</em>';
          i = m + 1;
        } else {
          out += '*';
          i = j + 1;
        }
      }
      continue;
    }
    const kk = findUnescaped(s, ']', j + 1);
    const m = kk !== -1 && s.charCodeAt(kk + 1) === 40 ? s.indexOf(')', kk + 2) : -1;
    const target = m === -1 ? '' : s.slice(kk + 2, m);
    if (target !== '' && !hasWs(target)) {
      out += '<a href="';
      out += esc(env.link(target));
      out += '">';
      out += inline(s.slice(j + 1, kk), env);
      out += '</a>';
      i = m + 1;
    } else {
      out += '[';
      i = j + 1;
    }
  }
  return out;
}

/** Lines [start, end) rendered: HTML, table of contents and excerpt. */
function renderMd(lines, start, end, env, slugCache) {
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  let i = start;
  while (i < end) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < end && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${esc(lang)}"`;
      let code = `<pre><code${cls}>`;
      for (const l of body) {
        code += esc(l);
        code += '\n';
      }
      code += '</code></pre>';
      blocks.push(code);
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const id = uniqueSlug(slugify(hd.text, slugCache), ids);
      const html = inline(hd.text, env);
      blocks.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const q = [];
      while (i < end && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        q.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const inner = [];
      for (const l of q) {
        const t = trimLine(l);
        if (t !== '') inner.push(t);
      }
      blocks.push(inner.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(inner.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    const first = listFirst(line);
    if (first !== null) {
      const isOrdered = first.ordered;
      const items = [];
      while (i < end) {
        let m = null;
        if (isOrdered) {
          const o = orderedMarker(lines[i]);
          if (o !== null) m = o.text;
        } else {
          m = bulletMarker(lines[i]);
        }
        if (m !== null) {
          items.push([trimLine(m)]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && first.start !== 1 ? `<ol start="${first.start}">` : `<${tag}>`;
      let lb = `${open}\n`;
      for (const it of items) lb += `<li>${inline(it.join('\n'), env)}</li>\n`;
      lb += `</${tag}>`;
      blocks.push(lb);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < end && !endsPara(lines[i])) {
      body.push(trimLine(lines[i]));
      i++;
    }
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

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
    const standalone = isBlankLine(src.slice(lineStart, open)) && isBlankLine(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** A node tree flattened into ops with jump targets. */
function flattenOps(nodes) {
  const ops = [];
  const emit = (list) => {
    for (const n of list) {
      if (n.k === 0 || n.k === 1 || n.k === 5) {
        ops.push(n);
        continue;
      }
      if (n.k === 2) {
        const op = { k: 2, p: n.p, not: n.not, els: -1, end: -1 };
        ops.push(op);
        emit(n.then);
        if (n.els !== null) {
          const eop = { k: 3, end: -1 };
          op.els = ops.length;
          ops.push(eop);
          emit(n.els);
          op.end = ops.length;
          eop.end = ops.length;
        } else {
          op.end = ops.length;
        }
        continue;
      }
      const op = { k: 4, p: n.p, name: n.name, end: -1 };
      ops.push(op);
      emit(n.body);
      op.end = ops.length;
    }
  };
  emit(nodes);
  return ops;
}

/** `src` parsed and compiled into flat ops (a TemplateError when it does not parse). */
function compileTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ k: 0, s: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ k: 1, p: tok.path, raw: tok.t === 'raw' });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', k: 4, name: m[1], p: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', k: 2, not: m[1] !== undefined, p: pathOf(name, m[2]), then: [], els: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.els !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.els = [];
        body = top.els;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.els ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ k: 5, name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return flattenOps(root.body);
}

/** The value at `path` in the scope chain: first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: string itself, number in JavaScript's digits, true/false, array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let k = 0; k < v.length; k++) {
      if (k > 0) s += ', ';
      s += textOf(v[k]);
    }
    return s;
  }
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Ops [start, end) rendered into `buf` in `scope`. */
function renderRange(ops, start, end, scope, buf, depth, templates) {
  let pc = start;
  while (pc < end) {
    const n = ops[pc];
    if (n.k === 0) {
      buf.push(n.s);
      pc++;
    } else if (n.k === 1) {
      const v = lookup(scope, n.p);
      // textOf() returns a string unchanged, so skip the call for one.
      const t = typeof v === 'string' ? v : textOf(v);
      buf.push(n.raw ? t : esc(t));
      pc++;
    } else if (n.k === 2) {
      const take = truthy(lookup(scope, n.p)) !== n.not;
      pc = take ? pc + 1 : n.els >= 0 ? n.els + 1 : n.end;
    } else if (n.k === 3) {
      pc = n.end;
    } else if (n.k === 4) {
      const xs = lookup(scope, n.p);
      if (Array.isArray(xs)) {
        // One vars object per for-execution, mutated per item: the body
        // renders synchronously, so no render ever sees a stale item.
        const vars = {};
        const loop = { index: 1, first: true, last: xs.length === 1, length: xs.length };
        vars[n.name] = undefined;
        vars.loop = loop;
        const sc = { vars, parent: scope };
        for (let k = 0; k < xs.length; k++) {
          vars[n.name] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderRange(ops, pc + 1, n.end, sc, buf, depth, templates);
        }
      }
      pc = n.end;
    } else {
      const t = templates.get(n.name);
      if (t !== undefined && depth < 8) renderRange(t, 0, t.length, scope, buf, depth + 1, templates);
      pc++;
    }
  }
}

// ---------------------------------------------------------------- the build

function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  const slugCache = new Map();
  const base = stripTrailingSlashes(input.site.base_url);
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(cmp)) {
    try {
      templates.set(name, compileTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  // 1. Sources, in code-unit order of path; line ends made "\n".
  const files = [...input.files].sort((x, y) => cmp(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter: refused sources and drafts reported and dropped.
  const kept = [];
  for (const s of sources) {
    const lines = s.text.split('\n');
    const fm = parseFM(lines);
    if (fm.error) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.lines = lines;
    s.start = fm.close + 1;
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
  sources = kept;

  // 3. Permalinks: slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMd(s.lines, s.start, s.lines.length, env, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, then by slug; newer/older neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags: grouped by slug, named as first met in collection order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags ?? [];
    for (const name of tags) {
      const sl = slugify(name, slugCache);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name, slugCache);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));

  // Cards, one per source (posts share theirs with the lists).
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOfLines(s.lines, s.start) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const s of sources) {
    s.card = cardOf(s);
    if (s.post) cards.set(s, s.card);
  }
  const pageOf = (s) => ({
    ...s.card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // 7. Layouts: every page, the index pages, the tag pages, then statics.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, vars) => {
    const ops = templates.get(name);
    if (ops === undefined) return null;
    const buf = [];
    renderRange(ops, 0, ops.length, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, buf, 0, templates);
    return buf.join('');
  };
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(cmp);
  const npages = sources.filter((s) => !s.post).length;
  lines.push(`built ${npages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
