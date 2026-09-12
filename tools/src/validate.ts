/**
 * Repo validator. Run: pnpm validate
 *
 * Checks, in order:
 *   1. manifest.yaml against schema/manifest.schema.json
 *   2. registry against schema/registry.schema.json; unique prefixes; well-formed OIDs
 *   3. every profiles/**\/*.yaml against schema/profile.schema.json, role must be `profile`
 *   4. every dictionaries/**\/*.json against the same schema, role must be `dictionary`
 *   5. cross-file: unique slugs, `extends`/`includes` resolvable, per-profile unique metricKey,
 *      sysObjectId patterns are OIDs, file name equals slug, dictionary vendorOidPrefix known to registry
 *
 * Exit code 1 on any error. Warnings do not fail the run.
 */
import { basename, join, relative } from 'node:path';
import { Ajv, type ErrorObject } from 'ajv';
import {
  REPO_ROOT, loadManifest, loadRegistry, loadYaml, loadJson, walkFiles, oidHasPrefix,
  type Manifest, type Registry,
} from './repo.js';

interface OidDef {
  oid: string; name: string; metricKey: string; type: string; walk: boolean;
  cadenceTier?: string;
}
interface ProfileDoc {
  formatVersion: number; slug: string; name: string; role?: 'profile' | 'dictionary';
  deviceCategory: string; vendor?: string | null; vendorOidPrefix?: string | null;
  extends?: string; includes?: string[]; enabled?: boolean;
  matchPatterns?: { field: string; pattern: string }[];
  oids: OidDef[]; tested?: unknown;
}

const errors: string[] = [];
const warnings: string[] = [];
const err = (file: string, msg: string) => errors.push(`${rel(file)}: ${msg}`);
const warn = (file: string, msg: string) => warnings.push(`${rel(file)}: ${msg}`);
const rel = (p: string) => relative(REPO_ROOT, p);
const OID_RE = /^[0-9]+(\.[0-9]+)*$/;

function fmtAjv(e: ErrorObject[] | null | undefined): string {
  return (e ?? []).map(x => `${x.instancePath || '/'} ${x.message ?? ''}`).join('; ');
}

async function main() {
  const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: false });
  const manifestSchema = await loadJson<object>(join(REPO_ROOT, 'schema/manifest.schema.json'));
  const registrySchema = await loadJson<object>(join(REPO_ROOT, 'schema/registry.schema.json'));
  const profileSchema = await loadJson<object>(join(REPO_ROOT, 'schema/profile.schema.json'));
  const vManifest = ajv.compile(manifestSchema);
  const vRegistry = ajv.compile(registrySchema);
  const vProfile = ajv.compile(profileSchema);

  // 1. manifest
  const manifestPath = join(REPO_ROOT, 'manifest.yaml');
  const manifest = await loadYaml<Manifest>(manifestPath);
  if (!vManifest(manifest)) err(manifestPath, fmtAjv(vManifest.errors));
  for (const [cat, parent] of Object.entries(manifest.defaultParents ?? {})) {
    if (!manifest.externalParents.includes(parent)) {
      warn(manifestPath, `defaultParents.${cat} = ${parent} is not in externalParents; validator will expect it inside this repo`);
    }
  }

  // 2. registry
  const registryPath = join(REPO_ROOT, manifest.paths.registry);
  const registry = await loadYaml<Registry>(registryPath);
  if (!vRegistry(registry)) err(registryPath, fmtAjv(vRegistry.errors));
  const seenPrefix = new Set<string>();
  for (const e of registry.entries ?? []) {
    if (!OID_RE.test(e.oidPrefix)) err(registryPath, `bad oidPrefix ${e.oidPrefix}`);
    if (seenPrefix.has(e.oidPrefix)) err(registryPath, `duplicate oidPrefix ${e.oidPrefix}`);
    seenPrefix.add(e.oidPrefix);
    if ((e.action ?? 'assign') !== 'assign' && !e.profileSlug) {
      err(registryPath, `${e.oidPrefix}: action ${e.action} requires profileSlug`);
    }
    if (e.defaultParent && !manifest.externalParents.includes(e.defaultParent)) {
      warn(registryPath, `${e.oidPrefix}: defaultParent ${e.defaultParent} not in manifest.externalParents`);
    }
  }

  // 3 + 4. profiles and dictionaries
  const profileFiles = await walkFiles(join(REPO_ROOT, manifest.paths.profiles), ['.yaml', '.yml']);
  const dictFiles = await walkFiles(join(REPO_ROOT, manifest.paths.dictionaries), ['.json']);
  const docs: { file: string; doc: ProfileDoc; kind: 'profile' | 'dictionary' }[] = [];

  for (const file of profileFiles) {
    let doc: ProfileDoc;
    try { doc = await loadYaml<ProfileDoc>(file); } catch (e) { err(file, `YAML parse: ${(e as Error).message}`); continue; }
    if (!vProfile(doc)) { err(file, fmtAjv(vProfile.errors)); continue; }
    if ((doc.role ?? 'profile') !== 'profile') err(file, `role must be "profile" under ${manifest.paths.profiles}/`);
    docs.push({ file, doc, kind: 'profile' });
  }
  for (const file of dictFiles) {
    let doc: ProfileDoc;
    try { doc = await loadJson<ProfileDoc>(file); } catch (e) { err(file, `JSON parse: ${(e as Error).message}`); continue; }
    if (!vProfile(doc)) { err(file, fmtAjv(vProfile.errors)); continue; }
    if (doc.role !== 'dictionary') err(file, `role must be "dictionary" under ${manifest.paths.dictionaries}/`);
    docs.push({ file, doc, kind: 'dictionary' });
  }

  // 5. cross-file
  const slugs = new Map<string, string>();
  for (const { file, doc } of docs) {
    if (slugs.has(doc.slug)) err(file, `slug ${doc.slug} already used by ${rel(slugs.get(doc.slug)!)}`);
    slugs.set(doc.slug, file);
    const base = basename(file).replace(/\.(ya?ml|json)$/i, '');
    if (base !== doc.slug) err(file, `file name "${base}" must equal slug "${doc.slug}"`);
  }
  const known = new Set<string>([...slugs.keys(), ...manifest.externalParents]);

  for (const { file, doc, kind } of docs) {
    // extends / includes
    if (doc.extends && doc.extends !== 'none' && !known.has(doc.extends)) {
      err(file, `extends "${doc.extends}" is neither in this repo nor in manifest.externalParents`);
    }
    for (const inc of doc.includes ?? []) {
      if (!known.has(inc)) err(file, `includes "${inc}" not found`);
      if (inc === doc.slug) err(file, `profile includes itself`);
    }
    // metricKey uniqueness + OID sanity + cadence advice
    // Profiles: duplicate metricKey is an error (the poller merges on it).
    // Dictionaries: MIB modules reuse object names, so report a per-file count only.
    const keys = new Set<string>();
    let dupKeys = 0;
    for (const o of doc.oids) {
      if (keys.has(o.metricKey)) {
        if (kind === 'profile') err(file, `duplicate metricKey "${o.metricKey}"`);
        else dupKeys++;
      }
      keys.add(o.metricKey);
      if (!OID_RE.test(o.oid)) err(file, `bad OID "${o.oid}" (${o.name})`);
      if (kind === 'dictionary' && doc.vendorOidPrefix && !oidHasPrefix(o.oid, doc.vendorOidPrefix)) {
        const root = o.oid.split('.').slice(0, 7).join('.');
        err(file, `OID ${o.oid} (${o.name}) is outside vendorOidPrefix ${doc.vendorOidPrefix} (enterprise ${root}); regenerate with pnpm compile`);
      }
      if (kind === 'profile' && !o.walk && !o.oid.endsWith('.0')) {
        warn(file, `${o.name}: scalar (walk=false) without trailing .0`);
      }
      if (kind === 'profile' && o.type === 'string' && !o.cadenceTier) {
        warn(file, `${o.name}: string-typed OID with no cadenceTier; platform will infer "discovery"`);
      }
    }
    // match patterns
    for (const m of doc.matchPatterns ?? []) {
      if (m.field === 'sysObjectId' && !OID_RE.test(m.pattern)) err(file, `sysObjectId pattern "${m.pattern}" is not an OID`);
      if (m.field === 'deviceCategory' && m.pattern !== doc.deviceCategory) {
        warn(file, `deviceCategory pattern "${m.pattern}" differs from profile deviceCategory "${doc.deviceCategory}"`);
      }
    }
    if (kind === 'profile') {
      if (doc.enabled !== false && !doc.tested) warn(file, `enabled profile has no "tested" block`);
      if (doc.vendor && !doc.extends) {
        const def = manifest.defaultParents[doc.deviceCategory];
        if (!def) warn(file, `vendor profile with no extends and no default parent for category ${doc.deviceCategory}`);
      }
    }
    if (kind === 'dictionary') {
      if (dupKeys > 0) warn(file, `${dupKeys} metricKey(s) reused across modules (allowed for dictionaries)`);
      const p = doc.vendorOidPrefix;
      if (p && !registry.entries.some(e => oidHasPrefix(p, e.oidPrefix) || oidHasPrefix(e.oidPrefix, p))) {
        warn(file, `vendorOidPrefix ${p} has no registry row`);
      }
      const inVendorDir = basename(join(file, '..'));
      if (doc.vendor && inVendorDir !== doc.vendor.toLowerCase().replace(/[^a-z0-9]+/g, '-')) {
        warn(file, `stored under "${inVendorDir}/" but vendor is "${doc.vendor}"`);
      }
    }
  }

  // Report
  const totalOids = docs.reduce((n, d) => n + d.doc.oids.length, 0);
  console.log(`manifest: ${manifest.namespace} rev ${manifest.revision}`);
  console.log(`registry: ${registry.entries.length} prefixes`);
  console.log(`profiles: ${profileFiles.length}   dictionaries: ${dictFiles.length}   OIDs: ${totalOids}`);
  if (warnings.length) {
    console.log(`\n${warnings.length} warning(s):`);
    for (const w of warnings) console.log(`  warn  ${w}`);
  }
  if (errors.length) {
    console.log(`\n${errors.length} error(s):`);
    for (const e of errors) console.log(`  ERROR ${e}`);
    process.exit(1);
  }
  console.log('\nOK');
}

main().catch(e => { console.error(e); process.exit(1); });
