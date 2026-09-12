/**
 * libsmi driver: locate `smidump`, run it over a set of MIB files with crash
 * isolation, and turn its XML exchange format into plain objects.
 *
 * Why libsmi (decision D-14, 2026-09-11): on a 14,921-file mirror it resolved
 * 1.58M unique OIDs where the previous in-house regex parser resolved 345k.
 * The one operational wrinkle is that libsmi 0.4.8 segfaults on a handful of
 * malformed vendor files, and because smidump prints at exit a crash loses the
 * whole invocation's output. `dumpFiles` therefore bisects the file list on a
 * crash until the offending file is isolated and reported.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';

const TOOLS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ────────────────────────────────────────────────────────────────
// Binary resolution
// ────────────────────────────────────────────────────────────────

export interface SmidumpBinary {
  command: string;
  version: string;
  /** true when running through tools/bin/smidump-docker */
  docker: boolean;
}

function probe(command: string): string | null {
  const r = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 120_000, env: process.env });
  if (r.error || r.status !== 0) return null;
  const line = (r.stdout || '').split('\n').find(l => /smidump/i.test(l)) ?? '';
  return line.trim() || 'smidump (unknown version)';
}

/**
 * Resolve the smidump binary: `$SMIDUMP` if set, else `smidump` on PATH,
 * else the Docker wrapper if Docker is available. Throws with install
 * instructions when none works.
 */
export function resolveSmidump(): SmidumpBinary {
  const explicit = process.env.SMIDUMP;
  if (explicit) {
    const v = probe(explicit);
    if (!v) throw new Error(`SMIDUMP=${explicit} does not run (\`${explicit} --version\` failed)`);
    return { command: explicit, version: v, docker: /smidump-docker/.test(explicit) };
  }
  const native = probe('smidump');
  if (native) return { command: 'smidump', version: native, docker: false };

  const wrapper = join(TOOLS_ROOT, 'bin', 'smidump-docker');
  const dockerOk = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 30_000 }).status === 0;
  if (existsSync(wrapper) && dockerOk) {
    const v = probe(wrapper);
    if (v) return { command: wrapper, version: v, docker: true };
  }
  throw new Error(
    'smidump (libsmi) not found. Install it: Debian/Ubuntu `apt install smitools`, macOS `brew install libsmi`, ' +
    'Fedora `dnf install libsmi`; or install Docker and the compiler will use tools/bin/smidump-docker automatically. ' +
    'Set SMIDUMP=/path/to/smidump to point at a specific binary.',
  );
}

// ────────────────────────────────────────────────────────────────
// Running smidump
// ────────────────────────────────────────────────────────────────

export interface RunResult {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  overflow: boolean;
}

/**
 * Run smidump once, guarded two ways:
 *  - `timeoutMs`: libsmi can hang. Natively the child is SIGKILLed; through the
 *    Docker wrapper the same deadline is enforced inside the container
 *    (SMIDUMP_TIMEOUT), because killing the docker client alone would leave the
 *    container running.
 *  - `maxBytes`: libsmi 0.4.8's XML and Python writers loop forever on some
 *    inputs (seen: ALCATEL-ENT1-TIMETRA-PORT-MIB emits `<range min="0" max="25"/>`
 *    without end). Output past the cap kills the run and marks it `overflow`.
 */
export function runSmidump(bin: SmidumpBinary, args: string[], smipath: string[], mounts: string[], timeoutMs: number, maxBytes: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      SMIPATH: smipath.join(':'),
      SMIDUMP_MOUNTS: mounts.join(':'),
      SMIDUMP_TIMEOUT: String(Math.ceil(timeoutMs / 1000)),
    };
    const child = spawn(bin.command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = [];
    let bytes = 0, timedOut = false, overflow = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs + 5_000);
    child.stdout.on('data', (b: Buffer) => {
      if (overflow) return;
      bytes += b.length;
      if (bytes > maxBytes) { overflow = true; out.length = 0; child.kill('SIGKILL'); return; }
      out.push(b);
    });
    child.stderr.on('data', (b: Buffer) => { if (err.length < 2000) err.push(b); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({
        stdout: overflow ? '' : Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        status, signal, timedOut, overflow,
      });
    });
  });
}

/** Deadline for one invocation, scaled by input size. */
export function timeoutFor(fileCount: number): number {
  return 30_000 + 250 * fileCount;
}

/** Output cap for one invocation. Real modules run ~1 KB per object; 1 MB per file is generous. */
export function maxBytesFor(fileCount: number): number {
  return 50 * 1024 * 1024 + 1024 * 1024 * fileCount;
}

/** Files per smidump invocation; bounds memory and makes bisection cheap. */
export const CHUNK_FILES = 150;

const XML_ARGS = ['-f', 'xml', '-k', '-q', '--xml-no-schema', '--xml-no-doctype'];

export interface DumpOutcome {
  /** one XML document per successful invocation */
  xml: string[];
  /** files that made smidump crash (isolated by bisection) */
  crashed: string[];
  /** single files on which smidump hung past the deadline */
  timedOut: string[];
  /** single files whose output ran past the cap (libsmi writer loop) */
  runaway: string[];
  /** distinct stderr lines, for the report */
  diagnostics: string[];
  invocations: number;
}

function completed(r: RunResult): boolean {
  // `-k` makes smidump exit 0 even with parse errors. A crash (SIGSEGV natively,
  // exit 139 through Docker) leaves the document unterminated.
  return !r.timedOut && !r.overflow && r.stdout.includes('</smi>') && r.signal === null && (r.status === 0 || r.status === 1);
}

/**
 * Dump `files` (paths or module names) as XML in chunks of CHUNK_FILES. When
 * an invocation crashes, hangs, or overflows, bisect until the offending input
 * is isolated so the rest of the group is still compiled.
 */
export async function dumpFiles(bin: SmidumpBinary, files: string[], smipath: string[], mounts: string[]): Promise<DumpOutcome> {
  const out: DumpOutcome = { xml: [], crashed: [], timedOut: [], runaway: [], diagnostics: [], invocations: 0 };
  const seen = new Set<string>();
  const addDiag = (stderr: string) => {
    for (const line of stderr.split('\n')) {
      const t = line.trim();
      if (t && !seen.has(t)) { seen.add(t); out.diagnostics.push(t); }
    }
  };
  const go = async (batch: string[]): Promise<void> => {
    if (batch.length === 0) return;
    const r = await runSmidump(bin, [...XML_ARGS, ...batch], smipath, mounts, timeoutFor(batch.length), maxBytesFor(batch.length));
    out.invocations++;
    addDiag(r.stderr);
    if (completed(r)) { out.xml.push(r.stdout); return; }
    if (batch.length === 1) {
      (r.overflow ? out.runaway : r.timedOut || r.status === 137 ? out.timedOut : out.crashed).push(batch[0]);
      return;
    }
    const mid = Math.ceil(batch.length / 2);
    await go(batch.slice(0, mid));
    await go(batch.slice(mid));
  };
  for (let i = 0; i < files.length; i += CHUNK_FILES) await go(files.slice(i, i + CHUNK_FILES));
  return out;
}

// ────────────────────────────────────────────────────────────────
// XML → objects
// ────────────────────────────────────────────────────────────────

export interface SmiTypeRef { module: string; name: string }

export interface SmiTypedef {
  module: string;
  /** null for the anonymous typedef inside an object's SYNTAX */
  name: string | null;
  /** libsmi base type: Integer32, Unsigned32, OctetString, Enumeration, Bits, … */
  basetype: string;
  /** named parent type when derived from one (e.g. TimeTicks, DisplayString) */
  parent: SmiTypeRef | null;
  /** number → label, for Enumeration and Bits */
  namedNumbers: Record<string, string> | null;
}

export interface SmiObject {
  module: string;
  name: string;
  oid: string;
  kind: 'scalar' | 'column';
  status: string;
  access: string;
  /** exactly one of the two is set */
  typeRef: SmiTypeRef | null;
  typedef: SmiTypedef | null;
  units: string | null;
  description: string | null;
}

export interface SmiModule {
  name: string;
  language: string | null;
  typedefs: SmiTypedef[];
  objects: SmiObject[];
  /** modules referenced by `<type module=…>` that are not part of this dump */
  imports: string[];
}

// preserveOrder element shape from fast-xml-parser
type PoNode = Record<string, unknown> & { ':@'?: Record<string, string> };

interface El { tag: string; attrs: Record<string, string>; children: El[]; text: string }

function toEl(n: PoNode): El | null {
  const tag = Object.keys(n).find(k => k !== ':@');
  if (!tag) return null;
  if (tag === '#text') return { tag, attrs: {}, children: [], text: String(n[tag] ?? '') };
  const kids = (n[tag] as PoNode[] | undefined) ?? [];
  const children: El[] = [];
  let text = '';
  for (const k of kids) {
    const e = toEl(k);
    if (!e) continue;
    if (e.tag === '#text') text += e.text; else children.push(e);
  }
  return { tag, attrs: (n[':@'] as Record<string, string> | undefined) ?? {}, children, text };
}

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
});

function child(el: El, tag: string): El | undefined { return el.children.find(c => c.tag === tag); }

function normalizeText(s: string | undefined | null): string | null {
  if (!s) return null;
  const t = s.replace(/\s+/g, ' ').trim();
  return t || null;
}

function readTypedef(el: El, module: string): SmiTypedef {
  const parentEl = child(el, 'parent');
  const nn = el.children.filter(c => c.tag === 'namednumber');
  const namedNumbers: Record<string, string> | null = nn.length
    ? Object.fromEntries(nn.map(c => [c.attrs.number, c.attrs.name]))
    : null;
  return {
    module,
    name: el.attrs.name ?? null,
    basetype: el.attrs.basetype ?? 'unknown',
    parent: parentEl ? { module: parentEl.attrs.module ?? '', name: parentEl.attrs.name ?? '' } : null,
    namedNumbers,
  };
}

function readObject(el: El, module: string, kind: 'scalar' | 'column'): SmiObject | null {
  const oid = el.attrs.oid;
  const name = el.attrs.name;
  if (!oid || !name || !/^\d+(\.\d+)+$/.test(oid)) return null;
  const syntax = child(el, 'syntax');
  const typeEl = syntax && child(syntax, 'type');
  const tdEl = syntax && child(syntax, 'typedef');
  return {
    module, name, oid, kind,
    status: el.attrs.status ?? 'current',
    access: child(el, 'access')?.text.trim() ?? 'unknown',
    typeRef: typeEl ? { module: typeEl.attrs.module ?? '', name: typeEl.attrs.name ?? '' } : null,
    typedef: tdEl ? readTypedef(tdEl, module) : null,
    units: normalizeText(child(el, 'units')?.text),
    description: normalizeText(child(el, 'description')?.text),
  };
}

/** Collect scalar/column objects at any depth (tables nest row nests column). */
function collectObjects(el: El, module: string, into: SmiObject[]): void {
  for (const c of el.children) {
    if (c.tag === 'scalar' || c.tag === 'column') {
      const o = readObject(c, module, c.tag);
      if (o) into.push(o);
    }
    if (c.children.length) collectObjects(c, module, into);
  }
}

/**
 * Parse one smidump XML document. Top-level children of <smi> come in
 * repeating runs: <module>, <imports>, <typedefs>, <nodes>, <notifications>,
 * <groups>, <compliances>; each run belongs to the preceding <module>.
 */
export function parseSmiXml(xml: string): SmiModule[] {
  // smidump writes one complete document (<?xml…?><smi>…</smi>) per module,
  // so a multi-module run is a concatenation. Split on the declaration.
  const docs = xml.split(/(?=<\?xml\b)/).filter(d => d.includes('<smi'));
  const modules: SmiModule[] = [];
  for (const d of docs) parseOneDocument(d, modules);
  const present = new Set(modules.map(m => m.name));
  for (const m of modules) {
    const refs = new Set<string>();
    for (const o of m.objects) {
      const r = o.typeRef?.module || o.typedef?.parent?.module;
      if (r && !present.has(r) && !BASE_MODULES.has(r)) refs.add(r);
    }
    m.imports = [...refs].sort();
  }
  return modules;
}

/** Modules whose types are built in; never fetched on demand. */
const BASE_MODULES = new Set(['', 'SNMPv2-SMI', 'RFC1155-SMI', 'RFC-1212', 'RFC-1215', 'SNMPv2-CONF']);

function parseOneDocument(xml: string, modules: SmiModule[]): void {
  const doc = parser.parse(xml) as PoNode[];
  const root = doc.map(toEl).find(e => e && e.tag === 'smi');
  if (!root) return;
  let cur: SmiModule | null = null;
  for (const el of root.children) {
    switch (el.tag) {
      case 'module':
        cur = { name: el.attrs.name ?? 'UNKNOWN', language: el.attrs.language ?? null, typedefs: [], objects: [], imports: [] };
        modules.push(cur);
        break;
      case 'typedefs':
        if (cur) for (const t of el.children) if (t.tag === 'typedef') cur.typedefs.push(readTypedef(t, cur.name));
        break;
      case 'nodes':
        if (cur) collectObjects(el, cur.name, cur.objects);
        break;
      default:
        break;
    }
  }
}

// ────────────────────────────────────────────────────────────────
// Type resolution
// ────────────────────────────────────────────────────────────────

export type DictType = 'integer' | 'string' | 'gauge' | 'counter' | 'timeticks' | 'oid';

/** libsmi base types and SMI named base types → dictionary type. */
const BASE_TYPE: Record<string, DictType> = {
  Integer32: 'integer', Integer64: 'integer', Enumeration: 'integer', INTEGER: 'integer',
  Unsigned32: 'gauge', Unsigned64: 'gauge', Gauge32: 'gauge', Gauge: 'gauge',
  Counter32: 'counter', Counter64: 'counter', Counter: 'counter',
  TimeTicks: 'timeticks',
  ObjectIdentifier: 'oid', 'OBJECT IDENTIFIER': 'oid',
  OctetString: 'string', IpAddress: 'string', NetworkAddress: 'string', Opaque: 'string', Bits: 'string',
};

export interface ResolvedType {
  type: DictType;
  enumMap: Record<string, string> | null;
  /** name of the textual convention the object used, if any */
  tc: string | null;
  /** true when a referenced TC could not be found and we fell back */
  unresolved: boolean;
}

/**
 * Global typedef table keyed "MODULE::Name". Filled from every dumped module
 * and from on-demand dumps of imported TC modules.
 */
export class TypeTable {
  private defs = new Map<string, SmiTypedef>();
  readonly modulesLoaded = new Set<string>();

  addModule(m: SmiModule): void {
    this.modulesLoaded.add(m.name);
    for (const t of m.typedefs) if (t.name) this.defs.set(`${m.name}::${t.name}`, t);
  }

  has(module: string): boolean { return this.modulesLoaded.has(module); }

  private fromNamed(ref: SmiTypeRef, depth: number): ResolvedType | null {
    if (BASE_MODULES.has(ref.module)) {
      const t = BASE_TYPE[ref.name];
      return t ? { type: t, enumMap: null, tc: null, unresolved: false } : null;
    }
    const td = this.defs.get(`${ref.module}::${ref.name}`);
    if (!td) return null;
    const r = this.fromTypedef(td, depth + 1);
    return { ...r, tc: ref.name };
  }

  fromTypedef(td: SmiTypedef, depth = 0): ResolvedType {
    // Prefer the named parent when it carries a distinction the base type
    // loses (Counter32 / Gauge32 / TimeTicks all have basetype Unsigned32).
    let base: ResolvedType | null = null;
    if (td.parent && depth < 8) base = this.fromNamed(td.parent, depth);
    const type = base?.type ?? BASE_TYPE[td.basetype] ?? 'string';
    const enumMap = td.namedNumbers ?? base?.enumMap ?? null;
    return { type, enumMap, tc: base?.tc ?? null, unresolved: base === null && td.parent !== null && td.parent.module !== '' };
  }

  resolve(o: SmiObject): ResolvedType {
    if (o.typedef) return this.fromTypedef(o.typedef);
    if (o.typeRef) {
      const r = this.fromNamed(o.typeRef, 0);
      if (r) return r;
      return { type: 'string', enumMap: null, tc: o.typeRef.name, unresolved: true };
    }
    return { type: 'string', enumMap: null, tc: null, unresolved: true };
  }
}
