// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines (SPEC.md section 3): its line break, its lines, whether it ends with a break. */
interface FileText {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(f: FileText): string {
  return f.lines.length === 0 ? '' : f.lines.join(f.br) + (f.final ? f.br : '');
}

/** Line matching at three tiers (SPEC.md section 5). */
const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

/** Every position where O occurs in the file's lines at one tier; occurrences may overlap. */
function occurrences(file: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > file.length) return out;
  for (let i = 0; i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(file[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs, with all its positions; null when it occurs at no tier. */
function matchAt(file: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(file, o, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One body line of a unified hunk or a V4A chunk: ' ' context, '-' old, '+' new. */
interface BodyLine {
  kind: ' ' | '-' | '+';
  text: string;
}

/** The lines that replace the matched region: context lines as the file's own, '+' lines re-indented at tier 2. */
function replaceWith(file: string[], pos: number, body: BodyLine[], tier: number): string[] {
  const first = body.find((b) => b.kind !== '+');
  const p = first === undefined ? '' : leadWs(first.text);
  const f = first === undefined ? '' : leadWs(file[pos]!);
  const out: string[] = [];
  let k = 0;
  for (const b of body) {
    if (b.kind === ' ') {
      out.push(file[pos + k]!);
      k++;
    } else if (b.kind === '-') {
      k++;
    } else {
      const t = b.text;
      out.push(tier === 2 && !/^[ \t]*$/.test(t) && t.startsWith(p) ? f + t.slice(p.length) : t);
    }
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, as [old, new] pairs, for the `R` output lines. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One hunk of a unified diff (SPEC.md section 6). */
interface Hunk {
  a: number;
  body: BodyLine[];
  /** a `\` line follows the hunk's last context or `+` line */
  noNL: boolean;
  /** a `\` line follows the hunk's last `+` line */
  plusNoNL: boolean;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(.+) b\/(.+)$/;

/** The path a `--- `/`+++ ` line names: after the four characters, up to the first tab, trimmed, a/ or b/ removed. */
function dashPath(line: string): string {
  const t = line.slice(4).split('\t')[0]!.trim();
  return t.startsWith('a/') || t.startsWith('b/') ? t.slice(2) : t;
}

/** One hunk, from its header line; returns the hunk and the index after its body. */
function parseHunk(lines: string[], at: number): { hunk: Hunk; next: number } {
  const m = HUNK_HEAD.exec(lines[at]!);
  if (m === null) throw new Exit2(`error: parse ${at + 1}`);
  const raw: string[] = [];
  let j = at + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && lines[j + 1] !== undefined && lines[j + 1]!.startsWith('+++ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      raw.push(l);
      j++;
      continue;
    }
    break;
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop(); // empty lines at the end of a body are not part of it
  const body: BodyLine[] = [];
  const afterSlash = new Set<number>(); // body indices a `\` line follows
  for (const l of raw) {
    if (l.startsWith('\\')) {
      if (body.length > 0) afterSlash.add(body.length - 1);
      continue;
    }
    body.push({ kind: l === '' ? ' ' : (l[0] as ' ' | '-' | '+'), text: l === '' ? '' : l.slice(1) });
  }
  let noNL = false;
  let plusNoNL = false;
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k]!.kind !== '-') {
      noNL = afterSlash.has(k);
      break;
    }
  }
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k]!.kind === '+') {
      plusNoNL = afterSlash.has(k);
      break;
    }
  }
  return { hunk: { a: parseInt(m[1]!, 10), body, noNL, plusNoNL }, next: j };
}

/** One section of a unified diff: old/new path (null: /dev/null), creation/deletion flags, hunks. */
interface Section {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    let diffOld: string | null = null;
    let diffNew: string | null = null;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      diffOld = m[1]!;
      diffNew = m[2]!;
      i++;
    } else if (!(l.startsWith('--- ') && lines[i + 1] !== undefined && lines[i + 1]!.startsWith('+++ '))) {
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`); // a hunk before any section
      i++; // prose outside sections is ignored
      continue;
    }
    let dashOld: string | null = null;
    let dashNew: string | null = null;
    let renOld: string | null = null;
    let renNew: string | null = null;
    let create = false;
    let remove = false;
    const hunks: Hunk[] = [];
    let header = true;
    while (i < n) {
      const x = lines[i]!;
      if (x.startsWith('diff --git ')) break; // the next section
      if (x.startsWith('@@')) {
        const h = parseHunk(lines, i);
        hunks.push(h.hunk);
        i = h.next;
        header = false;
        continue;
      }
      if (x.startsWith('--- ')) {
        const pair = lines[i + 1] !== undefined && lines[i + 1]!.startsWith('+++ ');
        if (header && dashOld === null) {
          if (!pair) throw new Exit2(`error: parse ${i + 2}`);
          dashOld = dashPath(x);
          dashNew = dashPath(lines[i + 1]!);
          i += 2;
          continue;
        }
        if (pair) break; // a pair after the header's own starts a new section
        if (header) throw new Exit2(`error: parse ${i + 2}`);
        i++; // prose between hunks is ignored
        continue;
      }
      if (header && x.startsWith('rename from ')) {
        renOld = x.slice(12).trim();
        i++;
        continue;
      }
      if (header && x.startsWith('rename to ')) {
        renNew = x.slice(10).trim();
        i++;
        continue;
      }
      if (header && x.startsWith('new file mode')) {
        create = true;
        i++;
        continue;
      }
      if (header && x.startsWith('deleted file mode')) {
        remove = true;
        i++;
        continue;
      }
      i++; // index/mode lines in a header, prose between hunks: ignored
    }
    const oldPath = dashOld ?? renOld ?? diffOld;
    const newPath = dashNew ?? renNew ?? diffNew;
    const sec: Section = {
      oldPath: oldPath === '/dev/null' ? null : oldPath,
      newPath: newPath === '/dev/null' ? null : newPath,
      create,
      remove,
      hunks,
    };
    edits.push(unifiedEdit(sec, strict));
  }
  return edits;
}

/** A section's hunks applied in order to a file's text. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const o = h.body.filter((b) => b.kind !== '+').map((b) => b.text);
    if (o.length === 0) {
      const ins = h.body.filter((b) => b.kind === '+').map((b) => b.text);
      const at = Math.min(h.a + d, f.lines.length);
      const atEnd = at === f.lines.length;
      f.lines.splice(at, 0, ...ins);
      if (atEnd) f.final = !h.noNL;
      d += ins.length;
      continue;
    }
    const found = matchAt(f.lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.pos[0]!;
    for (const p of found.pos) if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    const atEnd = best + o.length === f.lines.length;
    const rep = replaceWith(f.lines, best, h.body, found.tier);
    f.lines.splice(best, o.length, ...rep);
    if (atEnd) f.final = !h.noNL;
    d += rep.length - o.length;
  }
  return joinFile(f);
}

/** One section's edit: a creation, deletion, move or change. */
function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const isCreate = sec.oldPath === null || sec.create;
    const isDelete = !isCreate && (sec.newPath === null || sec.remove);
    if (isCreate) {
      const p = sec.newPath ?? '/dev/null';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.kind === '+') plus.push(b.text);
      let final = true;
      for (let k = sec.hunks.length - 1; k >= 0; k--) {
        const h = sec.hunks[k]!;
        if (h.body.some((b) => b.kind === '+')) {
          final = !h.plusNoNL;
          break;
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (isDelete) {
      const p = sec.oldPath ?? '/dev/null';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const oldP = sec.oldPath!;
    const newP = sec.newPath!;
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (!safe(newP)) throw new Fail('unsafe', newP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (oldP !== newP && tree.get(newP) !== null) throw new Fail('exists', newP);
    const out = applyHunks(before, sec.hunks, strict, oldP);
    if (oldP !== newP) {
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      tree.moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, out);
    }
  };
}

/** One SEARCH/REPLACE block's edit (SPEC.md section 7). */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = matchAt(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const pos = found.pos[0]!;
    const p = leadWs(oldLines[0]!);
    const fl = leadWs(f.lines[pos]!);
    const rep = newLines.map((t) => (found.tier === 2 && !/^[ \t]*$/.test(t) && t.startsWith(p) ? fl + t.slice(p.length) : t));
    f.lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, joinFile(f));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevPath: string | null = null;
  let prevEnd = 0; // index after the previous block's REPLACE line
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let j = searchLine + 1;
    const oldLines: string[] = [];
    while (j < n && lines[j]!.trimEnd() !== '=======') {
      oldLines.push(lines[j]!);
      j++;
    }
    if (j >= n) throw new Exit2(`error: parse ${searchLine + 1}`);
    j++;
    const newLines: string[] = [];
    while (j < n && lines[j]!.trimEnd() !== '>>>>>>> REPLACE') {
      newLines.push(lines[j]!);
      j++;
    }
    if (j >= n) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = j + 1;
    i = j + 1;
  }
  return edits;
}

/** One chunk of a V4A Update File section (SPEC.md section 8). */
interface Chunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

/** An Update File section's chunks applied in order to a file's text, with the cursor. */
function applyChunks(text: string, chunks: Chunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let cursor = 0;
  for (const c of chunks) {
    if (c.anchor !== null) {
      const a = matchAt(f.lines, [c.anchor], strict);
      const at = a === null ? undefined : a.pos.find((p) => p >= cursor);
      if (at === undefined) throw new Fail('no-match', path);
      cursor = at + 1;
    }
    const o = c.body.filter((b) => b.kind !== '+').map((b) => b.text);
    if (o.length === 0) {
      const ins = c.body.filter((b) => b.kind === '+').map((b) => b.text);
      const at = c.eof ? f.lines.length : cursor;
      f.lines.splice(at, 0, ...ins);
      cursor = at + ins.length;
      continue;
    }
    const found = matchAt(f.lines, o, strict);
    const pos = found === null ? undefined : found.pos.find((p) => p >= cursor && (!c.eof || p + o.length === f.lines.length));
    if (pos === undefined) throw new Fail('no-match', path);
    const rep = replaceWith(f.lines, pos, c.body, found.tier);
    f.lines.splice(pos, o.length, ...rep);
    cursor = pos + rep.length;
  }
  return joinFile(f);
}

/** An Add or Delete File section's edit. */
function v4aEdit(kind: 'add' | 'delete', path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (kind === 'add') {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      return;
    }
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

const V4A_STARTS = ['*** Add File: ', '*** Delete File: ', '*** Update File: '];

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const start = V4A_STARTS.find((s) => line.startsWith(s));
    if (start === undefined) throw new Exit2(`error: parse ${i + 1}`);
    const kind = start === '*** Add File: ' ? 'add' : start === '*** Delete File: ' ? 'delete' : 'update';
    const path = line.slice(start.length).trim();
    const sectionLine = i;
    i++;
    // collect the section's lines, up to the next section start or End Patch
    const raw: Array<{ text: string; line: number }> = [];
    while (i < last && !V4A_STARTS.some((s) => lines[i]!.startsWith(s))) {
      raw.push({ text: lines[i]!, line: i });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop(); // blank lines at the end of a section are not part of it
    if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.line + 1}`);
      edits.push(v4aEdit('delete', path, []));
      continue;
    }
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${r.line + 1}`);
      }
      edits.push(v4aEdit('add', path, fileLines));
      continue;
    }
    // update: an optional Move to, then chunks
    let moveTo: string | null = null;
    let k = 0;
    if (k < raw.length && raw[k]!.text.startsWith('*** Move to: ')) {
      moveTo = raw[k]!.text.slice('*** Move to: '.length).trim();
      k++;
    }
    const chunks: Chunk[] = [];
    let cur: Chunk | null = null;
    for (; k < raw.length; k++) {
      const r = raw[k]!;
      const t = r.text;
      if (t.startsWith('@@')) {
        cur = { anchor: t.slice(2).trim() === '' ? null : t.slice(2).trim(), body: [], eof: false };
        chunks.push(cur);
        continue;
      }
      if (t === '*** End of File') {
        if (cur === null) throw new Exit2(`error: parse ${r.line + 1}`);
        cur.eof = true;
        cur = null;
        continue;
      }
      if (t === '' || t.startsWith(' ') || t.startsWith('-') || t.startsWith('+')) {
        if (cur === null) {
          if (chunks.length > 0) throw new Exit2(`error: parse ${r.line + 1}`); // after the first chunk, a body line needs an @@
          cur = { anchor: null, body: [], eof: false };
          chunks.push(cur);
        }
        cur.body.push({ kind: t === '' ? ' ' : (t[0] as ' ' | '-' | '+'), text: t === '' ? '' : t.slice(1) });
        continue;
      }
      throw new Exit2(`error: parse ${r.line + 1}`);
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionLine + 1}`);
    edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
  }
  return edits;
}

/** An Update File section's edit (its own function so the strict flag reaches the matcher). */
function v4aUpdateEdit(path: string, moveTo: string | null, chunks: Chunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const out = applyChunks(before, chunks, strict, path);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const rows: Array<[string, string]> = [];
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push([p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`]);
  }
  for (const [oldP, newP] of tree.moves) {
    const d = rows.findIndex(([k, l]) => k === oldP && l.startsWith('D '));
    const a = rows.findIndex(([k, l]) => k === newP && l.startsWith('A '));
    if (d >= 0 && a >= 0) {
      rows.splice(Math.max(d, a), 1);
      rows.splice(Math.min(d, a), 1);
      rows.push([newP, `R ${oldP} -> ${newP}`]);
    }
  }
  rows.sort(([ka], [kb]) => byteCmp(ka, kb));
  const out = rows.map(([, l]) => l);
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteCmp)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
