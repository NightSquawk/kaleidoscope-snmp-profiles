/**
 * Convert Datadog SNMP profiles to Kaleidoscope profiles and measure how
 * faithful the conversion is. Dry run by default: nothing is written under
 * profiles/.
 *
 *   pnpm import:datadog --source /path/to/integrations-core
 *       [--out <dir>]        write converted YAML under <dir>/profiles/<category>/<vendor>/<slug>.yaml
 *       [--report <dir>]     default tools/.cache/datadog/report
 *       [--only a,b]         limit report and output to these Datadog profile ids (identity still uses all)
 *       [--recordings <dir>] default <source>/snmp/tests/compose/data
 *
 * `--source` may be an integrations-core checkout or a default_profiles
 * directory. Exit code 1 when an accuracy invariant fails (accounting,
 * schema); replay mismatches are reported, not fatal.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Ajv } from 'ajv';
import { Document, isMap, isScalar, isSeq, visit } from 'yaml';
import { REPO_ROOT, loadJson, loadManifest, loadRegistry } from './repo.js';
import { loadDatadogProfiles, type DdProfile } from './datadog/load.js';
import { MibIndex } from './datadog/mibindex.js';
import { modulesForOids } from './datadog/dictionary.js';
import { convertProfile, type Conversion, type IssueCode } from './datadog/convert.js';
import { loadRecording, type Recording } from './datadog/snmprec.js';
import { accounting, datadogWinner, kaleidoscopeWinner, replay, type ReplayResult } from './datadog/verify.js';

const PROFILES_SUBDIR = 'snmp/datadog_checks/snmp/data/default_profiles';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface Row {
  dd: DdProfile;
  conv: Conversion;
  accounting: string[];
  schema: string[];
  replay: ReplayResult | null;
  identity: { sysObjectId: string; dd: string[]; ours: string[]; agree: boolean } | null;
}

const YAML11_BOOL = /^(y|n|yes|no|on|off|true|false|null|~)$/i;

export function toYaml(doc: object): string {
  const d = new Document(doc);
  visit(d, {
    // Quote anything a YAML 1.1 reader (PyYAML) would retype or mis-split: on/off/yes/no, and
    // strings with flow indicators or regex syntax inside the flow-style maps and sequences.
    Scalar(_, node) {
      if (typeof node.value !== 'string') return;
      if (YAML11_BOOL.test(node.value) || !/^[A-Za-z0-9_.\/@+-][A-Za-z0-9_.\/@+ -]*$/.test(node.value)) node.type = 'QUOTE_DOUBLE';
    },
    Seq(_, node) { if (node.items.every(isScalar)) node.flow = true; },
    Pair(_, pair) {
      const k = isScalar(pair.key) ? pair.key.value : null;
      if ((k === 'datadog' || k === 'enumMap') && isMap(pair.value)) pair.value.flow = true;
      if (k === 'matchPatterns' || k === 'matchAny') {
        if (isSeq(pair.value)) for (const it of pair.value.items) if (isMap(it)) it.flow = true;
      }
    },
  });
  return d.toString({ lineWidth: 0, flowCollectionPadding: false });
}

async function main() {
  const source = arg('source');
  if (!source) { console.error('usage: pnpm import:datadog --source <integrations-core checkout | default_profiles dir> [--out dir] [--report dir] [--only a,b]'); process.exit(2); }
  const root = resolve(source);
  const profilesDir = existsSync(join(root, PROFILES_SUBDIR)) ? join(root, PROFILES_SUBDIR) : root;
  const repoRoot = profilesDir.endsWith(PROFILES_SUBDIR) ? profilesDir.slice(0, -PROFILES_SUBDIR.length - 1) : null;
  const recordingsDir = resolve(arg('recordings') ?? (repoRoot ? join(repoRoot, 'snmp/tests/compose/data') : join(profilesDir, 'recordings')));
  const reportDir = resolve(arg('report') ?? join(REPO_ROOT, 'tools/.cache/datadog/report'));
  const outDir = arg('out') ? resolve(arg('out')!) : null;
  const only = arg('only')?.split(',').map(s => s.trim().replace(/\.yaml$/, ''));
  if (outDir && resolve(outDir) === REPO_ROOT) {
    console.error('--out must not be the repository root: converted profiles are not imported until the converter is verified');
    process.exit(2);
  }

  const git = repoRoot ? spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }) : null;
  const commit = git?.status === 0 ? git.stdout.trim() : null;

  const manifest = await loadManifest();
  const registry = await loadRegistry(manifest);
  const dd = await loadDatadogProfiles(profilesDir);
  console.log(`datadog: ${dd.size} files in ${profilesDir}${commit ? ` @ ${commit.slice(0, 12)}` : ''}`);

  const allRefs = [...dd.values()].flatMap(p => p.refs);
  const modules = new Set<string>([
    ...allRefs.map(r => r.mib).filter((m): m is string => !!m),
    ...await modulesForOids(new Set(allRefs.map(r => r.oid))),
  ]);
  const { index, missingModules, failedFiles } = await MibIndex.build(modules, { log: console.log });

  const ajv = new Ajv({ allErrors: true, strict: false });
  const validateSchema = ajv.compile(await loadJson<object>(join(REPO_ROOT, 'schema/profile.schema.json')));

  const concrete = [...dd.values()].filter(p => !p.abstract);
  const rows: Row[] = [];
  const sourceRel = PROFILES_SUBDIR;
  const recordings = new Map<string, Recording>();
  for (const p of concrete) {
    const file = join(recordingsDir, `${p.id}.snmprec`);
    if (existsSync(file)) recordings.set(p.id, await loadRecording(file));
  }
  for (const p of concrete) {
    const conv = convertProfile(p, index, manifest, registry, commit, sourceRel, recordings.get(p.id));
    const schema: string[] = [];
    if (!validateSchema(conv.profile)) schema.push(...(validateSchema.errors ?? []).map(e => `${e.instancePath || '/'} ${e.message}`));
    const keys = new Set<string>();
    for (const o of conv.profile.oids) { if (keys.has(o.metricKey)) schema.push(`duplicate metricKey ${o.metricKey}`); keys.add(o.metricKey); }
    rows.push({ dd: p, conv, accounting: accounting(conv, p), schema, replay: null, identity: null });
  }
  const slugs = new Map<string, string>();
  for (const r of rows) {
    const s = r.conv.profile.slug;
    if (slugs.has(s)) r.schema.push(`slug ${s} also produced by ${slugs.get(s)}`);
    slugs.set(s, r.dd.file);
  }

  const allProfiles = rows.map(r => r.conv.profile);
  for (const r of rows) {
    const rec = recordings.get(r.dd.id);
    if (!rec) continue;
    r.replay = replay(r.conv, rec);
    if (rec.sysObjectId) {
      const d = datadogWinner(rec.sysObjectId, concrete);
      const k = kaleidoscopeWinner(rec.sysObjectId, allProfiles);
      const ddSlugs = d.ids.map(id => rows.find(x => x.dd.id === id)!.conv.profile.slug).sort();
      const ours = [...k.slugs].sort();
      r.identity = { sysObjectId: rec.sysObjectId, dd: ddSlugs, ours, agree: ddSlugs.join() === ours.join() };
    }
  }

  const selected = only ? rows.filter(r => only.includes(r.dd.id) || only.includes(r.conv.profile.slug)) : rows;

  if (outDir) {
    for (const r of selected) {
      const f = join(outDir, r.conv.path);
      await mkdir(dirname(f), { recursive: true });
      await writeFile(f, toYaml(r.conv.profile));
    }
    console.log(`wrote ${selected.length} profile(s) under ${outDir}`);
  }

  await mkdir(reportDir, { recursive: true });
  await writeFile(join(reportDir, 'results.json'), JSON.stringify(selected.map(r => ({
    id: r.dd.id, slug: r.conv.profile.slug, path: r.conv.path, category: r.conv.profile.deviceCategory, vendor: r.conv.profile.vendor,
    oids: r.conv.profile.oids.length, refs: r.dd.refs.length, accounting: r.accounting, schema: r.schema,
    issues: r.conv.issues, losses: r.conv.losses, replay: r.replay, identity: r.identity,
  })), null, 2));
  const md = report(selected, rows.length, { missingModules, failedFiles, commit, profilesDir, recordingsDir, mibObjects: index.size });
  await writeFile(join(reportDir, 'REPORT.md'), md);
  console.log(md.split('\n## Profiles')[0]);
  console.log(`report: ${join(reportDir, 'REPORT.md')}`);

  const fatal = selected.some(r => r.accounting.length || r.schema.length);
  process.exit(fatal ? 1 : 0);
}

function pct(n: number, d: number) { return d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a'; }

function report(rows: Row[], total: number, ctx: { missingModules: string[]; failedFiles: string[]; commit: string | null; profilesDir: string; recordingsDir: string; mibObjects: number }): string {
  const L: string[] = [];
  const sum = (f: (r: Row) => number) => rows.reduce((n, r) => n + f(r), 0);
  const withRec = rows.filter(r => r.replay);
  const ddAns = sum(r => r.replay?.ddAnswered ?? 0);
  const lost = sum(r => r.replay?.lost.length ?? 0);
  const entries = sum(r => r.replay?.entries ?? 0);
  const entriesAns = sum(r => r.replay?.entriesAnswered ?? 0);
  const typeMM = sum(r => r.replay?.typeMismatches.length ?? 0);
  const ident = rows.filter(r => r.identity);
  const identAgree = ident.filter(r => r.identity!.agree).length;
  const issueCount = new Map<IssueCode, number>();
  for (const r of rows) for (const i of r.conv.issues) issueCount.set(i.code, (issueCount.get(i.code) ?? 0) + 1);
  const lossKinds = new Map<string, number>();
  for (const r of rows) for (const l of r.conv.losses) { const k = l.split(/[ :=]/)[0]; lossKinds.set(k, (lossKinds.get(k) ?? 0) + 1); }

  L.push('# Datadog profile conversion report', '');
  L.push(`Source: \`${ctx.profilesDir}\`${ctx.commit ? ` @ \`${ctx.commit}\`` : ''}  `);
  L.push(`Recordings: \`${ctx.recordingsDir}\`  `);
  L.push(`MIB index: ${ctx.mibObjects} objects. Modules Datadog names that mibs/ lacks: ${ctx.missingModules.length ? ctx.missingModules.join(', ') : 'none'}. libsmi failures: ${ctx.failedFiles.length}.`, '');
  L.push('## Summary', '');
  L.push('| Check | Result |', '|---|---|');
  L.push(`| Profiles converted | ${rows.length}${rows.length !== total ? ` (of ${total})` : ''} |`);
  L.push(`| OID entries / Datadog references | ${sum(r => r.conv.profile.oids.length)} / ${sum(r => r.dd.refs.length)} |`);
  L.push(`| A. Accounting failures (must be 0) | ${sum(r => r.accounting.length)} |`);
  L.push(`| E. Schema / validator failures (must be 0) | ${sum(r => r.schema.length)} |`);
  L.push(`| B. Replay: profiles with a recording | ${withRec.length} |`);
  L.push(`| B. Replay: references Datadog answers | ${ddAns} |`);
  L.push(`| B. Replay: of those, converted entry also answers | ${ddAns - lost - sum(r => r.replay?.droppedButAnswered.length ?? 0)} (${pct(ddAns - lost - sum(r => r.replay?.droppedButAnswered.length ?? 0), ddAns)}) |`);
  L.push(`| B. Replay: lost (Datadog answers, we do not) | ${lost} |`);
  L.push(`| B. Replay: dropped references that answer | ${sum(r => r.replay?.droppedButAnswered.length ?? 0)} |`);
  L.push(`| B. Replay: Datadog scalars that needed \`.0\` retry | ${sum(r => r.replay?.ddNeededDot0 ?? 0)} |`);
  L.push(`| C. Entries answering in recording | ${entriesAns} / ${entries} |`);
  L.push(`| C. Type mismatches vs wire | ${typeMM} (${pct(typeMM, entriesAns)}) |`);
  L.push(`| C. Types taken from the recording (C cannot check these) | ${sum(r => r.conv.issues.filter(i => i.code === 'type-from-recording').length)} |`);
  L.push(`| D. Identity agrees with Datadog | ${identAgree} / ${ident.length} |`);
  L.push(`| Profiles needing OR matching (\`matchAny\`) | ${rows.filter(r => r.conv.profile.matchAny).length} |`);
  L.push('');
  L.push('### Conversion notes by kind', '', '| Code | Count |', '|---|---|');
  for (const [k, v] of [...issueCount].sort((a, b) => b[1] - a[1])) L.push(`| ${k} | ${v} |`);
  L.push('', '### Datadog features not carried over', '', '| Feature | Occurrences |', '|---|---|');
  for (const [k, v] of [...lossKinds].sort((a, b) => b[1] - a[1])) L.push(`| ${k} | ${v} |`);

  L.push('', '## Profiles', '');
  L.push('| Profile | Category | Vendor | OIDs | Unresolved | Replay answered | Lost | Type mm | Identity | Losses |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const un = r.conv.issues.filter(i => i.code === 'unresolved').length;
    const rp = r.replay;
    const id = !r.identity ? '–' : r.identity.agree ? 'ok' : `**dd ${r.identity.dd.join('/') || 'none'} ≠ ours ${r.identity.ours.join('/') || 'none'}**`;
    L.push(`| ${r.conv.profile.slug} | ${r.conv.profile.deviceCategory} | ${r.conv.profile.vendor ?? '–'} | ${r.conv.profile.oids.length} | ${un} | ${rp ? `${rp.bothAnswered}/${rp.ddAnswered}` : '–'} | ${rp ? (rp.lost.length ? `**${rp.lost.length}**` : 0) : '–'} | ${rp ? rp.typeMismatches.length : '–'} | ${id} | ${r.conv.losses.length} |`);
  }

  const failures = rows.filter(r => r.accounting.length || r.schema.length || r.replay?.lost.length || r.replay?.droppedButAnswered.length || r.replay?.typeMismatches.length || (r.identity && !r.identity.agree));
  if (failures.length) {
    L.push('', '## Details', '');
    for (const r of failures) {
      L.push(`### ${r.conv.profile.slug}`, '');
      for (const a of r.accounting) L.push(`- accounting: ${a}`);
      for (const s of r.schema) L.push(`- schema: ${s}`);
      for (const l of r.replay?.lost ?? []) L.push(`- lost: ${l.name} ${l.oid} (${l.role}) → ${l.entry}`);
      for (const d of r.replay?.droppedButAnswered ?? []) L.push(`- dropped but answers: ${d.name} ${d.oid} (${d.reason})`);
      for (const t of r.replay?.typeMismatches ?? []) L.push(`- type: ${t.name} ${t.oid} declared ${t.declared}, wire ${t.wire}`);
      if (r.identity && !r.identity.agree) L.push(`- identity: ${r.identity.sysObjectId} → Datadog ${r.identity.dd.join(', ') || 'none'}, Kaleidoscope ${r.identity.ours.join(', ') || 'none'}`);
      L.push('');
    }
  }
  return L.join('\n') + '\n';
}

main().catch(e => { console.error(e); process.exit(1); });
