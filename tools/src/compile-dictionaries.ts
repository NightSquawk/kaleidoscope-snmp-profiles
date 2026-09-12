/**
 * Dictionary compiler, libsmi edition.
 *
 *   pnpm compile [--mibs <dir>] [--out <dir>] [--vendor <slug>] [--jobs N] [--smipath a:b] [--report <file>]
 *
 * For every vendor directory under `--mibs` (default: manifest paths.mibs) it
 * runs `smidump -f xml` once over all of that directory's files with the
 * standard MIBs on SMIPATH, isolates any file that crashes libsmi, resolves
 * each object's type through the textual conventions it imports, groups
 * objects by the compile-enabled rows in registry/sysobjectid.yaml
 * (octet-anchored, shortest matching prefix wins), drops objects outside the
 * row's prefix and objects that cannot be polled, and writes one dictionary
 * JSON per vendor+category plus a Markdown report.
 *
 * Replaced the in-house regex parser on 2026-09-11 (decision D-14): on the
 * same 14,921-file mirror libsmi resolved 1.58M unique OIDs vs 345k.
 */
import { readdir, stat, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve, basename, extname } from 'node:path';
import {
  REPO_ROOT, loadManifest, loadRegistry, oidHasPrefix, slugifyVendor, type RegistryEntry,
} from './repo.js';
import {
  resolveSmidump, dumpFiles, parseSmiXml, TypeTable, type SmidumpBinary, type SmiModule, type SmiObject,
} from './smidump.js';

// ────────────────────────────────────────────────────────────────
// CLI
// ────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const ENTERPRISE = '1.3.6.1.4.1.';
const DESCRIPTION_MAX = 200;
/** Access values libsmi emits for objects a manager can read. */
const READABLE = new Set(['readonly', 'readwrite', 'readcreate']);
const SKIP_EXT = new Set(['.md', '.markdown', '.html', '.htm', '.zip', '.gz', '.tgz', '.tar', '.pdf', '.json', '.yaml', '.yml', '.xml', '.py', '.sh', '.js', '.ts', '.csv', '.doc', '.docx']);
const SKIP_NAME = /readme|license|licence|changelog|copying|\.gitkeep$/i;

/** Path for humans: relative to the repo when inside it, absolute otherwise. */
function show(p: string): string {
  const r = relative(REPO_ROOT, p);
  return r && !r.startsWith('..') ? r : p;
}

/** Directories that hold standard (non-vendor) modules; used for SMIPATH, never compiled. */
const BASE_DIR_NAMES = ['rfc', 'ietf', 'iana', '_base', 'standard', 'std'];
const SYSTEM_BASE_DIRS = ['/usr/share/snmp/mibs', '/usr/share/mibs/ietf', '/usr/share/mibs/iana', '/usr/share/mibs/site', '/usr/local/share/snmp/mibs', '/opt/homebrew/share/snmp/mibs'];

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

interface OidEntry {
  oid: string; name: string; description?: string; type: string; walk: boolean; metricKey: string;
  transform: string | null; enumMap: Record<string, string> | null;
  units?: string; status?: string; module?: string; tc?: string;
}

interface Bucket {
  entry: RegistryEntry;
  oids: Map<string, OidEntry>;
  modules: Set<string>;
  sourceDirs: Set<string>;
}

interface Group { name: string; dir: string; files: string[] }

interface GroupResult {
  group: Group;
  modules: SmiModule[];
  crashed: string[];
  timedOut: string[];
  runaway: string[];
  diagnostics: string[];
  invocations: number;
  ms: number;
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

function truncate(desc: string | null | undefined, max = DESCRIPTION_MAX): string | undefined {
  if (!desc) return undefined;
  return desc.length <= max ? desc : desc.slice(0, max - 3) + '...';
}

function enterpriseRoot(oid: string): string | null {
  if (!oid.startsWith(ENTERPRISE)) return null;
  const n = oid.slice(ENTERPRISE.length).split('.')[0];
  return n ? ENTERPRISE + n : null;
}

/**
 * Registry row for one object: the SHORTEST compile-enabled prefix that
 * contains the OID. Deeper rows refine sysObjectID identity for auto-match;
 * they do not split a vendor's MIB objects into separate dictionaries.
 */
function rowFor(oid: string, entries: RegistryEntry[]): RegistryEntry | null {
  let best: RegistryEntry | null = null;
  for (const e of entries) {
    if (e.compile === false) continue;
    if (!oidHasPrefix(oid, e.oidPrefix)) continue;
    if (!best || e.oidPrefix.split('.').length < best.oidPrefix.split('.').length) best = e;
  }
  return best;
}

function compareOid(a: string, b: string): number {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? -1) - (y[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

async function listMibFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let names: string[];
  try { names = await readdir(dir); } catch { return out; }
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    const s = await stat(full);
    if (s.isDirectory()) { out.push(...await listMibFiles(full)); continue; }
    if (s.size === 0 || SKIP_NAME.test(name) || SKIP_EXT.has(extname(name).toLowerCase())) continue;
    out.push(full);
  }
  return out;
}

/** Vendor directories become groups; loose files at the root form the `_root` group. */
async function discoverGroups(mibDir: string, baseDirs: Set<string>): Promise<Group[]> {
  const groups: Group[] = [];
  const root: string[] = [];
  for (const name of (await readdir(mibDir)).sort()) {
    if (name.startsWith('.')) continue;
    const full = join(mibDir, name);
    const s = await stat(full);
    if (s.isDirectory()) {
      // Standard-module dirs (rfc/, iana/…) stay on SMIPATH for imports and
      // are also compiled, so registry rows for standard subtrees can be
      // filled from them. Nothing in them is under enterprises, so without
      // such rows they only add to the "standard-tree" count.
      const files = await listMibFiles(full);
      if (files.length) groups.push({ name, dir: full, files });
    } else if (s.size > 0 && !SKIP_NAME.test(name) && !SKIP_EXT.has(extname(name).toLowerCase())) {
      root.push(full);
    }
  }
  if (root.length) groups.push({ name: '_root', dir: mibDir, files: root });
  return groups;
}

/** Run `fn` over items with at most `limit` in flight; results keep input order. */
async function pool<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────

async function main() {
  const manifest = await loadManifest();
  const registry = await loadRegistry(manifest);
  const mibDir = resolve(arg('mibs') ?? join(REPO_ROOT, manifest.paths.mibs));
  const outDir = resolve(arg('out') ?? join(REPO_ROOT, manifest.paths.dictionaries));
  const reportFile = resolve(arg('report') ?? join(outDir, 'COMPILE-REPORT.md'));
  const onlyVendor = arg('vendor')?.toLowerCase();
  const jobs = Math.max(1, Number(arg('jobs') ?? 4) || 4);

  if (!existsSync(mibDir)) { console.error(`MIB directory not found: ${mibDir}`); process.exit(2); }

  const bin: SmidumpBinary = resolveSmidump();
  console.log(`compiler: ${bin.version}${bin.docker ? ' (via Docker)' : ''}`);

  // SMIPATH: standard-module dirs inside the source tree, system dirs, then --smipath extras.
  const baseDirs = new Set<string>();
  for (const n of BASE_DIR_NAMES) { const d = join(mibDir, n); if (existsSync(d)) baseDirs.add(resolve(d)); }
  // The repo's own mibs/rfc always counts, so --mibs <elsewhere> (and the CI
  // fixture) resolve SNMPv2-SMI even on hosts with no system MIB directory.
  for (const n of BASE_DIR_NAMES) { const d = join(REPO_ROOT, manifest.paths.mibs, n); if (existsSync(d)) baseDirs.add(resolve(d)); }
  for (const d of SYSTEM_BASE_DIRS) if (existsSync(d)) baseDirs.add(d);
  for (const d of (arg('smipath') ?? '').split(':').filter(Boolean)) if (existsSync(d)) baseDirs.add(resolve(d));
  const smipathBase = [...baseDirs];
  if (smipathBase.length === 0) console.warn('warning: no standard-MIB directory found (mibs/rfc or /usr/share/snmp/mibs); imports of SNMPv2-SMI etc. will fail');

  let groups = await discoverGroups(mibDir, baseDirs);
  // Standard-module dirs first: OIDs are deduped per dictionary in group order,
  // so the canonical rfc/ copy of Printer-MIB wins over a vendor's bundled one
  // and the IETF dictionaries list rfc as their source.
  groups.sort((a, z) => Number(!baseDirs.has(resolve(a.dir))) - Number(!baseDirs.has(resolve(z.dir))) || a.name.localeCompare(z.name));
  if (onlyVendor) groups = groups.filter(g => g.name.toLowerCase() === onlyVendor || slugifyVendor(g.name) === onlyVendor);
  const totalFiles = groups.reduce((n, g) => n + g.files.length, 0);
  console.log(`groups: ${groups.length}   files: ${totalFiles}   smipath: ${smipathBase.map(show).join(':')}`);
  if (groups.length === 0) { console.log('Nothing to compile. Is mibs/ populated? See mibs/README.md.'); return; }

  const types = new TypeTable();
  const t0 = Date.now();
  let done = 0;

  // Phase 1: dump every group (bounded concurrency), keep results in group order.
  const results = await pool(groups, jobs, async (g): Promise<GroupResult> => {
    const start = Date.now();
    const smipath = [...smipathBase, g.dir];
    const outcome = await dumpFiles(bin, g.files, smipath, [mibDir]);
    const modules = outcome.xml.flatMap(parseSmiXml);
    done++;
    const objs = modules.reduce((n, m) => n + m.objects.length, 0);
    const notes = [outcome.crashed.length ? `${outcome.crashed.length} crash(es)` : '', outcome.timedOut.length ? `${outcome.timedOut.length} hang(s)` : '', outcome.runaway.length ? `${outcome.runaway.length} runaway` : '', outcome.invocations > 1 ? `${outcome.invocations} runs` : ''].filter(Boolean).join(', ');
    console.log(`  [${String(done).padStart(3)}/${groups.length}] ${g.name.padEnd(24)} ${String(g.files.length).padStart(5)} files ${String(objs).padStart(7)} objects  ${((Date.now() - start) / 1000).toFixed(1)}s${notes ? `  (${notes})` : ''}`);
    return { group: g, modules, crashed: outcome.crashed, timedOut: outcome.timedOut, runaway: outcome.runaway, diagnostics: outcome.diagnostics, invocations: outcome.invocations, ms: Date.now() - start };
  });

  // Phase 2: typedef table from everything dumped, then fetch TC modules that
  // were only imported (SNMPv2-TC, CISCO-TC, …) by module name through SMIPATH.
  for (const r of results) for (const m of r.modules) types.addModule(m);
  const wanted = new Map<string, Set<string>>(); // module → group dirs that import it
  for (const r of results) for (const m of r.modules) for (const imp of m.imports) {
    if (types.has(imp)) continue;
    if (!wanted.has(imp)) wanted.set(imp, new Set());
    wanted.get(imp)!.add(r.group.dir);
  }
  let tcFetched = 0, tcMissing: string[] = [];
  if (wanted.size) {
    // One dump with every group dir on SMIPATH; the modules are looked up by name.
    const allDirs = [...new Set([...smipathBase, ...[...wanted.values()].flatMap(s => [...s])])];
    const outcome = await dumpFiles(bin, [...wanted.keys()].sort(), allDirs, [mibDir]);
    const fetched = outcome.xml.flatMap(parseSmiXml);
    for (const m of fetched) { types.addModule(m); tcFetched++; }
    if (process.env.KSP_DEBUG) console.log('tc fetch wanted:', [...wanted.keys()], 'got:', fetched.map(m => m.name), 'diag:', outcome.diagnostics.slice(0, 5));
    tcMissing = [...wanted.keys()].filter(m => !types.has(m)).sort();
  }

  // Phase 3: resolve, group by registry row, dedupe by OID (first group in
  // alphabetical order wins, so output is deterministic).
  const buckets = new Map<string, Bucket>();
  const unregistered = new Map<string, { oids: number; modules: Set<string>; dirs: Set<string> }>();
  const seenModules = new Set<string>();
  const stats = { objects: 0, standard: 0, unpollable: 0, dupModules: 0, unresolvedType: 0, kept: 0 };
  const unresolvedTc = new Map<string, number>();

  for (const r of results) {
    for (const m of r.modules) {
      // Different vendors reuse module names (D-Link and Nortel both ship an
      // AAC-MIB), so a module name is not an identity. Count repeats for the
      // report but keep going; the per-bucket OID map dedupes real copies.
      if (seenModules.has(m.name)) stats.dupModules++;
      seenModules.add(m.name);
      for (const o of m.objects) {
        stats.objects++;
        if (!READABLE.has(o.access)) { stats.unpollable++; continue; }
        // Registry rows may name standard subtrees too (Printer-MIB, UPS-MIB,
        // HOST-RESOURCES…), so match rows first; only unmatched enterprise
        // objects count as "unregistered", unmatched standard ones as "standard".
        const row = rowFor(o.oid, registry.entries);
        const root = enterpriseRoot(o.oid);
        if (!row) {
          if (!root) { stats.standard++; continue; }
          const u = unregistered.get(root) ?? { oids: 0, modules: new Set<string>(), dirs: new Set<string>() };
          u.oids++; u.modules.add(m.name); u.dirs.add(r.group.name); unregistered.set(root, u);
          continue;
        }
        const key = `${row.vendor}::${row.deviceCategory}`;
        let b = buckets.get(key);
        if (!b) { b = { entry: row, oids: new Map(), modules: new Set(), sourceDirs: new Set() }; buckets.set(key, b); }
        else if (b.entry.oidPrefix !== row.oidPrefix) {
          // Two compile-enabled rows with the same vendor + category but different
          // roots would share one dictionary whose vendorOidPrefix can only name
          // one of them, and validate would reject the other's OIDs. Give the
          // second row a distinct vendor name (e.g. "Brocade FC") instead.
          console.error(`registry: rows ${b.entry.oidPrefix} and ${row.oidPrefix} both map to ${key}; use distinct vendor names or compile: false`);
          process.exit(2);
        }
        if (b.oids.has(o.oid)) continue;
        const t = types.resolve(o);
        if (t.unresolved) { stats.unresolvedType++; if (t.tc) unresolvedTc.set(t.tc, (unresolvedTc.get(t.tc) ?? 0) + 1); }
        // Format rule (docs/FORMAT.md): scalars carry the instance suffix `.0`
        // so an entry can be polled as-is; columns stay at the object OID and
        // are walked.
        const entry: OidEntry = {
          oid: o.kind === 'scalar' ? `${o.oid}.0` : o.oid, name: o.name, description: truncate(o.description), type: t.type,
          walk: o.kind === 'column', metricKey: o.name, transform: null, enumMap: t.enumMap,
        };
        if (o.units) entry.units = o.units;
        if (o.status !== 'current') entry.status = o.status;
        entry.module = m.name;
        if (t.tc) entry.tc = t.tc;
        b.oids.set(o.oid, entry);
        b.modules.add(m.name);
        b.sourceDirs.add(r.group.name);
        stats.kept++;
      }
    }
  }

  // Phase 4: write dictionaries. Wipe previous output first so removed rows disappear.
  if (!onlyVendor) {
    for (const name of existsSync(outDir) ? await readdir(outDir) : []) {
      const full = join(outDir, name);
      if ((await stat(full)).isDirectory()) await rm(full, { recursive: true });
    }
  }
  const date = new Date().toISOString().slice(0, 10);
  const written: { slug: string; oids: number; modules: number; dirs: string[] }[] = [];
  for (const b of [...buckets.values()].sort((a, z) => a.entry.vendor.localeCompare(z.entry.vendor) || a.entry.deviceCategory.localeCompare(z.entry.deviceCategory))) {
    const vendorSlug = slugifyVendor(b.entry.vendor);
    const slug = `mib-${vendorSlug}-${slugifyVendor(b.entry.deviceCategory)}`; // access_point → access-point
    const oids = [...b.oids.values()].sort((x, y) => compareOid(x.oid, y.oid));
    if (oids.length === 0) continue;
    const cat = b.entry.deviceCategory;
    const modules = [...b.modules].sort();
    const dirs = [...b.sourceDirs].sort();
    const doc = {
      formatVersion: 1,
      slug,
      name: `${b.entry.vendor} ${cat.charAt(0).toUpperCase() + cat.slice(1)} (MIB)`,
      role: 'dictionary',
      deviceCategory: cat,
      vendor: b.entry.vendor,
      vendorOidPrefix: b.entry.oidPrefix,
      description: `Auto-compiled with libsmi from ${modules.length} MIB module(s). ${oids.length} readable OIDs under ${b.entry.oidPrefix}.`,
      generated: {
        source: dirs.map(d => `${manifest.paths.mibs}/${d}`).join(', '),
        date,
        oidCount: oids.length,
        compiler: bin.version,
        modules,
      },
      oids,
    };
    const dir = join(outDir, vendorSlug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${slug}.json`), JSON.stringify(doc, null, 2) + '\n');
    written.push({ slug, oids: oids.length, modules: modules.length, dirs });
    console.log(`  ${slug.padEnd(34)} ${String(oids.length).padStart(7)} OIDs  ${String(modules.length).padStart(4)} modules  from ${dirs.join(', ')}`);
  }

  // Phase 5: report.
  const crashed = results.flatMap(r => r.crashed.map(f => relative(mibDir, f)));
  const hung = results.flatMap(r => r.timedOut.map(f => relative(mibDir, f)));
  const runaway = results.flatMap(r => r.runaway.map(f => relative(mibDir, f)));
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  const totalOids = written.reduce((n, w) => n + w.oids, 0);
  const unreg = [...unregistered.entries()].sort((a, b) => b[1].oids - a[1].oids);
  const lines: string[] = [];
  lines.push('# Compile report', '', `Generated ${date} by \`pnpm compile\` with ${bin.version}. Do not edit; rerun the compiler.`, '');
  lines.push('## Summary', '');
  lines.push('| | |', '|---|---|');
  lines.push(`| MIB source | \`${show(mibDir)}\` |`);
  lines.push(`| Vendor directories | ${groups.length} |`, `| Files given to libsmi | ${totalFiles} |`, `| smidump invocations | ${results.reduce((n, r) => n + r.invocations, 0)} |`);
  lines.push(`| Modules parsed | ${seenModules.size} (${stats.dupModules} repeated module names, kept) |`);
  lines.push(`| Objects seen | ${stats.objects} |`, `| Dropped: standard tree, no registry row | ${stats.standard} |`, `| Dropped: not readable (not-accessible, accessible-for-notify) | ${stats.unpollable} |`);
  lines.push(`| Dropped: enterprise has no registry row | ${unreg.reduce((n, [, u]) => n + u.oids, 0)} across ${unreg.length} roots |`);
  lines.push(`| Written | ${written.length} dictionaries, ${totalOids} OIDs |`);
  lines.push(`| Textual-convention modules fetched on demand | ${tcFetched} (${tcMissing.length} not found) |`);
  lines.push(`| Objects whose type fell back to string | ${stats.unresolvedType} |`);
  lines.push(`| Files that crashed libsmi | ${crashed.length} |`, `| Files on which libsmi hung | ${hung.length} |`, `| Files with runaway output | ${runaway.length} |`, `| Wall time | ${elapsed}s (${jobs} jobs) |`, '');
  lines.push('## Dictionaries', '', '| Slug | OIDs | Modules | Source dirs |', '|---|---:|---:|---|');
  for (const w of written) lines.push(`| ${w.slug} | ${w.oids} | ${w.modules} | ${w.dirs.join(', ')} |`);
  lines.push('');
  lines.push('## Enterprises with MIBs but no registry row', '', 'Add a row to `registry/sysobjectid.yaml` to compile any of these, then import the source directory under `mibs/`. Sorted by object count.', '', '| Enterprise root | Readable objects | Modules | Example module | Source dirs |', '|---|---:|---:|---|---|');
  for (const [root, u] of unreg) lines.push(`| ${root} | ${u.oids} | ${u.modules.size} | ${[...u.modules].sort()[0]} | ${[...u.dirs].sort().slice(0, 6).join(', ')}${u.dirs.size > 6 ? ', …' : ''} |`);
  lines.push('');
  if (crashed.length) {
    lines.push('## Files that crashed libsmi', '', 'smidump exited abnormally on these inputs; they were skipped. Each was isolated by bisection so the rest of the directory still compiled. They are malformed by other parsers too.', '');
    for (const f of crashed) lines.push(`- \`${f}\``);
    lines.push('');
  }
  if (hung.length) {
    lines.push('## Files on which libsmi hung', '', 'smidump did not finish within the deadline on these inputs even alone; they were skipped.', '');
    for (const f of hung) lines.push(`- \`${f}\``);
    lines.push('');
  }
  const rejected = [...new Set(results.flatMap(r => r.diagnostics).map(d => /cannot locate module [`']([^`']+)'/.exec(d)?.[1]).filter((p): p is string => !!p && p.startsWith('/')))].map(p => relative(mibDir, p)).sort();
  if (rejected.length) {
    lines.push('## Files libsmi rejected', '', 'libsmi could not parse these files as SMI modules (syntax errors, undeterminable SMI version). They contributed nothing. The exact message is in the diagnostics section.', '');
    for (const f of rejected) lines.push(`- \`${f}\``);
    lines.push('');
  }
  if (runaway.length) {
    lines.push('## Files with runaway output', '', "libsmi's XML writer looped on these inputs (output ran past the size cap); they were skipped. Known libsmi 0.4.8 bug on certain SIZE constraints.", '');
    for (const f of runaway) lines.push(`- \`${f}\``);
    lines.push('');
  }
  if (tcMissing.length) {
    lines.push('## Textual-convention modules not found', '', 'Objects typed by these modules fell back to `string`. Add the module to `mibs/rfc/` or the vendor directory.', '');
    for (const m of tcMissing) lines.push(`- ${m}`);
    lines.push('');
  }
  if (unresolvedTc.size) {
    lines.push('## Unresolved textual conventions (top 30)', '', '| TC | Objects |', '|---|---:|');
    for (const [tc, n] of [...unresolvedTc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) lines.push(`| ${tc} | ${n} |`);
    lines.push('');
  }
  const diag = [...new Set(results.flatMap(r => r.diagnostics))].filter(d => !/^smidump: module .* contains errors/.test(d));
  if (diag.length) {
    lines.push('## libsmi diagnostics', '', `${diag.length} distinct message(s); first 100.`, '');
    for (const d of diag.slice(0, 100)) lines.push(`- ${d.replace(/`/g, "'")}`);
    lines.push('');
  }
  await mkdir(outDir, { recursive: true });
  await writeFile(reportFile, lines.join('\n'));

  console.log(`\nwritten: ${written.length} dictionaries, ${totalOids} OIDs → ${show(outDir)}`);
  console.log(`objects: ${stats.objects} seen, ${stats.standard} standard-tree without a row, ${stats.unpollable} not readable, ${stats.dupModules} repeated module names, ${stats.unresolvedType} typed as string for lack of a TC`);
  console.log(`unregistered enterprises: ${unreg.length} (${unreg.reduce((n, [, u]) => n + u.oids, 0)} objects) — see ${show(reportFile)}`);
  if (crashed.length) console.log(`crashed files skipped: ${crashed.length} — listed in the report`);
  if (hung.length) console.log(`hung files skipped: ${hung.length} — listed in the report`);
  if (runaway.length) console.log(`runaway-output files skipped: ${runaway.length} — listed in the report`);
  console.log(`time: ${elapsed}s`);
}

main().catch(e => { console.error(e); process.exit(1); });
