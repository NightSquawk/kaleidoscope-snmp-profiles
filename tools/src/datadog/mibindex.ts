/**
 * Per-OID MIB facts for the Datadog converter: object name, defining module,
 * type, enumeration, scalar/column, and for columns the INDEX objects of their
 * row (AUGMENTS followed). Built by running libsmi over only the modules the
 * Datadog profiles touch, plus every standard module in mibs/rfc, because the
 * compiled dictionaries cover registered vendor trees and carry no index data.
 *
 * The result is cached under tools/.cache/ keyed by the input files' sizes and
 * mtimes, so only the first run pays for smidump.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { REPO_ROOT, loadManifest } from '../repo.js';
import {
  TypeTable, dumpFiles, parseSmiXml, resolveSmidump,
  type SmiModule, type SmiObject, type SmiTypeRef,
} from '../smidump.js';

export interface MibObject {
  oid: string;           // scalars carry `.0`, columns do not (dictionary convention)
  name: string;
  module: string;
  type: string;
  walk: boolean;
  enumMap: Record<string, string> | null;
  /** false when libsmi gave no usable SYNTAX (e.g. an un-imported SMIv1 `Gauge`); `type` is then a placeholder */
  typeKnown: boolean;
  /** libsmi access: readonly, readwrite, readcreate, noaccess, notifyonly */
  access: string;
  /** columns: INDEX object names of the row, after following AUGMENTS */
  index?: string[];
  /** the MIB says its enumeration values are bit masks, so combined values occur */
  bitmask?: boolean;
}

export const READABLE = new Set(['readonly', 'readwrite', 'readcreate']);
const BASE_DIR_NAMES = ['rfc', 'ietf', 'iana', '_base', 'standard', 'std'];
const SKIP = /\.(md|json|ya?ml|xml|py|sh|js|ts|csv|html?|pdf|zip|gz)$|readme|license|licence|changelog/i;
// Comment lines may sit between the module name and DEFINITIONS (FCMGMT-MIB).
const BITMASK_NOTE = /values are bit ?masks/i;
const DEFINITIONS_RE = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*(?:--[^\n]*\n\s*)*DEFINITIONS\s*::=\s*BEGIN/gm;
const CACHE_DIR = join(REPO_ROOT, 'tools', '.cache', 'datadog');

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await readdir(dir).catch(() => [] as string[])).sort()) {
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    const s = await stat(full);
    if (s.isDirectory()) out.push(...await listFiles(full));
    else if (!SKIP.test(name)) out.push(full);
  }
  return out;
}

/** Module name (upper-cased) → files that define it, across mibs/. Cached. */
async function moduleFiles(mibDir: string): Promise<Map<string, string[]>> {
  const cache = join(CACHE_DIR, 'module-files.json');
  const files = await listFiles(mibDir);
  const stamp = createHash('sha1').update(DEFINITIONS_RE.source);
  for (const f of files) { const s = await stat(f); stamp.update(`${f}\0${s.size}\0${s.mtimeMs}\n`); }
  const key = stamp.digest('hex');
  if (existsSync(cache)) {
    const c = JSON.parse(await readFile(cache, 'utf8')) as { key: string; map: Record<string, string[]> };
    if (c.key === key) return new Map(Object.entries(c.map));
  }
  const map = new Map<string, string[]>();
  for (const f of files) {
    const text = await readFile(f, 'latin1');
    for (const m of text.matchAll(DEFINITIONS_RE)) {
      const k = m[1].toUpperCase();
      const list = map.get(k) ?? [];
      if (!list.includes(f)) list.push(f);
      map.set(k, list);
    }
  }
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cache, JSON.stringify({ key, map: Object.fromEntries(map) }));
  return map;
}

export interface MibIndexBuild {
  index: MibIndex;
  /** requested module names with no defining file under mibs/ */
  missingModules: string[];
  /** files libsmi crashed, hung, or ran away on */
  failedFiles: string[];
}

export class MibIndex {
  constructor(private byOid: Map<string, MibObject>) {}

  /** Flag objects whose enumeration the MIB text declares as bit masks. libsmi drops comments, so this reads the source. */
  async markBitmasks(files: Iterable<string>): Promise<number> {
    const names = new Set<string>();
    for (const f of files) {
      const text = await readFile(f, 'latin1');
      if (!BITMASK_NOTE.test(text)) continue;
      const tcs = new Set<string>();
      // Types are TEXTUAL-CONVENTIONs (SMIv2) or plain `Name ::= INTEGER { … }` assignments (SMIv1).
      const HEAD = /^\s*([A-Za-z][\w-]*)\s*(::=\s*TEXTUAL-CONVENTION|::=\s*INTEGER\s*\{|OBJECT-TYPE)/gm;
      const heads = [...text.matchAll(HEAD)];
      const blocks = heads.map((h, i) => [h[1], h[2].startsWith('OBJECT') ? 'OBJECT-TYPE' : 'TYPE', text.slice(h.index! + h[0].length, heads[i + 1]?.index ?? text.length)] as const);
      for (const [name, kind, body] of blocks) if (kind !== 'OBJECT-TYPE' && BITMASK_NOTE.test(body)) tcs.add(name);
      for (const [name, kind, body] of blocks) {
        if (kind !== 'OBJECT-TYPE') continue;
        const syntax = /SYNTAX\s+([A-Za-z][\w-]*)/.exec(body)?.[1];
        const inline = /SYNTAX\s+INTEGER\s*\{[^}]*\}/.exec(body)?.[0] ?? '';
        if ((syntax && tcs.has(syntax)) || BITMASK_NOTE.test(inline)) names.add(name);
      }
    }
    let n = 0;
    for (const o of this.byOid.values()) if (o.enumMap && names.has(o.name)) { o.bitmask = true; n++; }
    return n;
  }

  private names?: Map<string, MibObject[]>;

  /** Objects by name, the given module's definition first (INDEX objects live next to their table). */
  named(name: string, module?: string): MibObject | undefined {
    if (!this.names) {
      this.names = new Map();
      for (const o of this.byOid.values()) this.names.set(o.name, [...(this.names.get(o.name) ?? []), o]);
    }
    const list = this.names.get(name) ?? [];
    return list.find(o => o.module === module) ?? list[0];
  }

  get size() { return this.byOid.size; }

  get(oid: string) { return this.byOid.get(oid); }

  /**
   * Resolve an OID as written in a profile. Scalars are stored with `.0`,
   * columns without an index. Tries the exact OID, then the scalar written
   * without its `.0`, then the nearest enclosing column (a specific row
   * instance, possibly with a multi-arc index).
   */
  resolve(oid: string): { entry: MibObject; form: 'exact' | 'no-instance' | 'indexed'; instance?: string } | null {
    const exact = this.byOid.get(oid);
    if (exact) return { entry: exact, form: 'exact' };
    const scalar = this.byOid.get(oid + '.0');
    if (scalar && !scalar.walk) return { entry: scalar, form: 'no-instance' };
    for (let cut = oid.lastIndexOf('.'), hops = 0; cut > 0 && hops < 16; cut = oid.lastIndexOf('.', cut - 1), hops++) {
      const col = this.byOid.get(oid.slice(0, cut));
      if (col?.walk) return { entry: col, form: 'indexed', instance: oid.slice(cut + 1) };
    }
    return null;
  }

  /**
   * Build from the given module names (case-insensitive). Every file in the
   * standard-module directories is always included.
   */
  static async build(wantedModules: Iterable<string>, opts: { log?: (s: string) => void } = {}): Promise<MibIndexBuild> {
    const log = opts.log ?? (() => {});
    const t0 = Date.now();
    const phase = (s: string) => log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
    const manifest = await loadManifest();
    const mibDir = resolve(REPO_ROOT, manifest.paths.mibs);
    const baseDirs = BASE_DIR_NAMES.map(n => join(mibDir, n)).filter(existsSync);
    const byModule = await moduleFiles(mibDir);
    phase(`module map: ${byModule.size} modules`);

    const wanted = [...new Set([...wantedModules].map(m => m.toUpperCase()))].sort();
    const files = new Set<string>();
    for (const d of baseDirs) for (const f of await listFiles(d)) files.add(f);
    const missingModules: string[] = [];
    for (const m of wanted) {
      const hits = byModule.get(m);
      if (!hits) { missingModules.push(m); continue; }
      // Prefer a standard-directory copy, else the first vendor copy.
      const std = hits.find(f => baseDirs.some(d => f.startsWith(d + '/')));
      if (!std) files.add(hits[0]);
    }

    const stamp = createHash('sha1').update('v3\n');
    for (const f of [...files].sort()) { const s = await stat(f); stamp.update(`${f}\0${s.size}\0${s.mtimeMs}\n`); }
    const key = stamp.digest('hex');
    const cache = join(CACHE_DIR, 'mib-index.json');
    if (existsSync(cache)) {
      const c = JSON.parse(await readFile(cache, 'utf8')) as { key: string; objects: MibObject[]; failedFiles: string[] };
      if (c.key === key) {
        log(`mib index: ${c.objects.length} objects (cached)`);
        const index = new MibIndex(new Map(c.objects.map(o => [o.oid, o])));
        log(`mib index: ${await index.markBitmasks(files)} bit-mask enumerations`);
        return { index, missingModules, failedFiles: c.failedFiles };
      }
    }

    phase('resolving smidump');
    const bin = resolveSmidump();
    // Group by directory so each dump resolves imports from its own vendor tree first.
    const byDir = new Map<string, string[]>();
    for (const f of files) { const d = dirname(f); byDir.set(d, [...(byDir.get(d) ?? []), f]); }
    log(`mib index: dumping ${files.size} files in ${byDir.size} directories with ${bin.version}`);
    const modules: SmiModule[] = [];
    const failedFiles: string[] = [];
    for (const [dir, list] of byDir) {
      phase(`dump ${dir} (${list.length} files)`);
      const out = await dumpFiles(bin, list.sort(), [...baseDirs, dir], [mibDir]);
      modules.push(...out.xml.flatMap(parseSmiXml));
      failedFiles.push(...out.crashed, ...out.timedOut, ...out.runaway);
    }

    // Textual conventions imported but not dumped (SNMPv2-TC, vendor TC modules).
    const types = new TypeTable();
    for (const m of modules) types.addModule(m);
    const tcWanted = [...new Set(modules.flatMap(m => m.imports))].filter(m => !types.has(m)).sort();
    phase(`parsed ${modules.length} modules; fetching ${tcWanted.length} TC modules`);
    if (tcWanted.length) {
      const out = await dumpFiles(bin, tcWanted, [...baseDirs, ...byDir.keys()], [mibDir]);
      for (const m of out.xml.flatMap(parseSmiXml)) types.addModule(m);
    }

    // Row name → INDEX, to follow AUGMENTS (ifXEntry → ifEntry → ifIndex).
    const rows = new Map<string, { index: SmiTypeRef[]; augments: SmiTypeRef | null }>();
    for (const m of modules) for (const o of m.objects) {
      if (o.row) rows.set(`${m.name}::${o.row.name}`, o.row);
    }
    const indexOf = (o: SmiObject): string[] | undefined => {
      let row: { index: SmiTypeRef[]; augments: SmiTypeRef | null } | undefined = o.row;
      for (let hops = 0; row && hops < 8; hops++) {
        if (row.index.length) return row.index.map(r => r.name);
        if (!row.augments) break;
        row = rows.get(`${row.augments.module}::${row.augments.name}`);
      }
      return undefined;
    };

    const objects = new Map<string, MibObject>();
    for (const m of modules) for (const o of m.objects) {
      // Unreadable objects are kept (flagged by `access`): Datadog profiles
      // reference INDEX columns, which are not-accessible and never answer.
      const oid = o.kind === 'scalar' ? `${o.oid}.0` : o.oid;
      const prev = objects.get(oid);
      if (prev && (READABLE.has(prev.access) || !READABLE.has(o.access))) continue;
      const t = types.resolve(o);
      const entry: MibObject = { oid, name: o.name, module: m.name, type: t.type, walk: o.kind === 'column', enumMap: t.enumMap, typeKnown: !t.unresolved, access: o.access };
      if (o.kind === 'column') {
        const idx = indexOf(o);
        if (idx) entry.index = idx;
      }
      objects.set(oid, entry);
    }

    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cache, JSON.stringify({ key, objects: [...objects.values()], failedFiles }));
    log(`mib index: ${objects.size} objects from ${modules.length} modules`);
    const index = new MibIndex(objects);
    log(`mib index: ${await index.markBitmasks(files)} bit-mask enumerations`);
    return { index, missingModules, failedFiles };
  }
}
