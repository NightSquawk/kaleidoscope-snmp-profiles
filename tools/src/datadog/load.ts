/**
 * Datadog SNMP profile loader.
 *
 * Reads a directory of Datadog profiles (integrations-core
 * snmp/datadog_checks/snmp/data/default_profiles), resolves `extends` the way
 * the agent does (base metrics first, base metric_tags appended, metadata
 * fields overridden by the child), and flattens every OID the profile would
 * touch into a list of references with enough context to convert or explain
 * each one.
 *
 * Format reference: integrations-core docs/developer/tutorials/snmp/profile-format.md
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

// ── Raw Datadog shapes (only what we read) ─────────────────────────────

export interface DdSymbol {
  OID?: string;
  name: string;
  metric_type?: string;
  scale_factor?: number;
  extract_value?: string;
  match_pattern?: string;
  match_value?: string;
  format?: string;
  constant_value_one?: boolean;
}

export interface DdMetricTag {
  tag?: string;
  // table-metric form
  symbol?: DdSymbol | string;
  table?: string;
  MIB?: string;
  index?: number;
  index_transform?: { start: number; end: number }[];
  mapping?: Record<string, string>;
  // global form: { OID, symbol: name, tag } or with match/tags
  OID?: string;
  match?: string;
  tags?: Record<string, string>;
}

export interface DdMetric {
  MIB?: string;
  symbol?: DdSymbol;
  table?: { OID: string; name: string };
  symbols?: DdSymbol[];
  metric_type?: string;
  metric_tags?: DdMetricTag[];
  options?: { placement?: number; metric_suffix?: string };
}

export interface DdField {
  value?: string;
  symbol?: DdSymbol;
  symbols?: DdSymbol[];
}

export interface DdProfileRaw {
  extends?: string[];
  sysobjectid?: string | string[];
  device?: { vendor?: string };
  metrics?: DdMetric[];
  metric_tags?: DdMetricTag[];
  metadata?: Record<string, { fields?: Record<string, DdField>; id_tags?: DdMetricTag[] }>;
}

// ── Flattened view ──────────────────────────────────────────────────────

export type RefRole =
  | 'metric'        // a value Datadog submits as a metric
  | 'column-tag'    // a table column used to tag rows of another table
  | 'global-tag'    // a scalar used to tag every metric of the device
  | 'metadata';     // device/interface inventory field

export interface DdRef {
  oid: string;
  ddName: string;
  role: RefRole;
  /** Datadog's structural view: `symbol` → scalar, `symbols` / tag column → table. */
  structure: 'scalar' | 'table';
  mib?: string;
  /** Datadog table the metric belongs to, or the table a column tag labels */
  table?: string;
  metricType?: string;
  mapping?: Record<string, string>;
  tag?: string;
  /** metadata resource.field, e.g. `device.serial_number` */
  field?: string;
  /** Datadog features on this reference that the Kaleidoscope format cannot express. */
  features: string[];
  /** profile file that declared the reference (differs from the profile when inherited) */
  source: string;
}

/** A reference with no OID: index tags, constant metrics, static metadata values. */
export interface DdNonOidRef {
  kind: 'index-tag' | 'constant-metric' | 'static-metadata' | 'global-tag-regex';
  detail: string;
  source: string;
}

export interface DdProfile {
  file: string;
  /** file name without .yaml */
  id: string;
  abstract: boolean;
  sysobjectids: string[];
  vendorHint: string | null;
  /** extends chain, depth-first, deduplicated, excluding the profile itself */
  ancestors: string[];
  refs: DdRef[];
  nonOid: DdNonOidRef[];
  /** Datadog e2e recordings are named after the profile; filled by the caller. */
}

export const normOid = (oid: string) => String(oid).trim().replace(/^\./, '');

export async function loadDatadogProfiles(dir: string): Promise<Map<string, DdProfile>> {
  const files = (await readdir(dir)).filter(f => f.endsWith('.yaml')).sort();
  const raw = new Map<string, DdProfileRaw>();
  for (const f of files) raw.set(f, (parseYaml(await readFile(join(dir, f), 'utf8')) ?? {}) as DdProfileRaw);

  const out = new Map<string, DdProfile>();
  for (const f of files) out.set(f, flatten(f, raw));
  return out;
}

function flatten(file: string, raw: Map<string, DdProfileRaw>): DdProfile {
  const own = raw.get(file)!;
  const ancestors: string[] = [];
  const refs: DdRef[] = [];
  const nonOid: DdNonOidRef[] = [];
  const metadata = new Map<string, { source: string; def: DdField; resource: string; name: string }>();

  // Agent order: for each extends entry, expand it recursively and put its
  // metrics before the child's. Metadata fields: child overrides base.
  const visit = (f: string, stack: string[]) => {
    if (stack.includes(f)) throw new Error(`${file}: extends cycle ${[...stack, f].join(' -> ')}`);
    const p = raw.get(f);
    if (!p) throw new Error(`${stack.at(-1) ?? file}: extends unknown profile ${f}`);
    for (const base of p.extends ?? []) {
      visit(base, [...stack, f]);
      if (!ancestors.includes(base)) ancestors.push(base);
    }
    collect(f, p, refs, nonOid);
    for (const [resource, section] of Object.entries(p.metadata ?? {})) {
      for (const [name, def] of Object.entries(section.fields ?? {})) {
        metadata.set(`${resource}.${name}`, { source: f, def, resource, name });
      }
      for (const t of section.id_tags ?? []) collectTag(f, t, 'table', undefined, refs, nonOid);
    }
  };
  visit(file, []);

  for (const [key, { source, def }] of metadata) {
    const syms = [...(def.symbol ? [def.symbol] : []), ...(def.symbols ?? [])];
    if (!syms.length && def.value !== undefined) {
      nonOid.push({ kind: 'static-metadata', detail: `${key} = ${JSON.stringify(def.value)}`, source });
    }
    for (const s of syms) {
      if (!s.OID) continue;
      const resource = key.split('.')[0];
      refs.push({
        oid: normOid(s.OID), ddName: s.name, role: 'metadata',
        structure: resource === 'device' ? 'scalar' : 'table',
        field: key, features: symbolFeatures(s), source,
      });
    }
  }

  const sysobjectids = own.sysobjectid === undefined ? [] : ([] as string[]).concat(own.sysobjectid).map(String);
  const vendorHint = own.device?.vendor
    ?? findStaticVendor(file, raw)
    ?? null;

  return {
    file, id: file.replace(/\.yaml$/, ''),
    abstract: file.startsWith('_') || sysobjectids.length === 0,
    sysobjectids, vendorHint, ancestors, refs, nonOid,
  };
}

/** The nearest `metadata.device.fields.vendor.value` in the extends chain. */
function findStaticVendor(file: string, raw: Map<string, DdProfileRaw>, seen = new Set<string>()): string | null {
  if (seen.has(file)) return null;
  seen.add(file);
  const p = raw.get(file);
  if (!p) return null;
  const v = p.metadata?.device?.fields?.vendor?.value;
  if (v) return v;
  for (const base of [...(p.extends ?? [])].reverse()) {
    const hit = findStaticVendor(base, raw, seen);
    if (hit) return hit;
  }
  return null;
}

function symbolFeatures(s: DdSymbol): string[] {
  const f: string[] = [];
  if (s.scale_factor !== undefined) f.push(`scale_factor=${s.scale_factor}`);
  if (s.extract_value !== undefined) f.push(`extract_value=${s.extract_value}`);
  if (s.match_pattern !== undefined) f.push(`match_pattern=${s.match_pattern}`);
  if (s.format !== undefined) f.push(`format=${s.format}`);
  return f;
}

function collect(source: string, p: DdProfileRaw, refs: DdRef[], nonOid: DdNonOidRef[]) {
  for (const m of p.metrics ?? []) {
    if (m.symbol) {
      const s = m.symbol;
      if (s.constant_value_one) { nonOid.push({ kind: 'constant-metric', detail: s.name, source }); continue; }
      if (!s.OID) continue;
      const features = symbolFeatures(s);
      const metricType = s.metric_type ?? m.metric_type;
      if (metricType === 'flag_stream') {
        features.push(`flag_stream placement=${m.options?.placement} suffix=${m.options?.metric_suffix}`);
      }
      refs.push({
        oid: normOid(s.OID), ddName: s.name, role: 'metric', structure: 'scalar',
        mib: m.MIB, metricType, features, source,
      });
      // scalar metrics may carry metric_tags too (rare)
      for (const t of m.metric_tags ?? []) collectTag(source, t, 'scalar', m.MIB, refs, nonOid);
    }
    if (m.symbols) {
      for (const s of m.symbols) {
        if (s.constant_value_one) {
          nonOid.push({ kind: 'constant-metric', detail: `${m.table?.name ?? '?'}.${s.name}`, source });
          continue;
        }
        if (!s.OID) continue;
        const features = symbolFeatures(s);
        const metricType = s.metric_type ?? m.metric_type;
        if (metricType === 'flag_stream') {
          features.push(`flag_stream placement=${m.options?.placement} suffix=${m.options?.metric_suffix}`);
        }
        refs.push({
          oid: normOid(s.OID), ddName: s.name, role: 'metric',
          // `symbols` without `table` is how constant/scalar groups are written;
          // treat it as a table only when a table is named.
          structure: m.table ? 'table' : 'scalar',
          mib: m.MIB, table: m.table?.name, metricType, features, source,
        });
      }
      for (const t of m.metric_tags ?? []) collectTag(source, t, 'table', m.MIB, refs, nonOid, m.table?.name, m.table?.OID);
    }
  }
  for (const t of p.metric_tags ?? []) collectTag(source, t, 'global', undefined, refs, nonOid);
}

function collectTag(
  source: string, t: DdMetricTag, ctx: 'table' | 'scalar' | 'global', mib: string | undefined,
  refs: DdRef[], nonOid: DdNonOidRef[], ownTable?: string, ownTableOid?: string,
) {
  if (t.index !== undefined && !t.symbol) {
    nonOid.push({
      kind: 'index-tag',
      detail: `${ownTable ?? '?'} index ${t.index} -> tag ${t.tag}${t.mapping ? ' (mapped)' : ''}`,
      source,
    });
    return;
  }
  // global form: { OID: x, symbol: 'name', tag | match/tags }
  if (typeof t.symbol === 'string' || (t.OID && ctx === 'global')) {
    const name = typeof t.symbol === 'string' ? t.symbol : (t.symbol as DdSymbol | undefined)?.name ?? '?';
    const oid = t.OID ?? (t.symbol as DdSymbol | undefined)?.OID;
    if (!oid) return;
    const features: string[] = [];
    if (t.match) {
      features.push(`match=${t.match}`);
      nonOid.push({ kind: 'global-tag-regex', detail: `${name} ~ ${t.match} -> ${JSON.stringify(t.tags)}`, source });
    }
    refs.push({
      oid: normOid(oid), ddName: name, role: 'global-tag', structure: 'scalar',
      tag: t.tag, mapping: t.mapping, features, source,
    });
    return;
  }
  const s = t.symbol as DdSymbol | undefined;
  if (!s?.OID) return;
  const features = symbolFeatures(s);
  if (t.index_transform) features.push(`index_transform=${JSON.stringify(t.index_transform)}`);
  // Datadog names the other table only sometimes; a column outside the metric table's subtree is a join too.
  const outside = ownTableOid && !normOid(s.OID).startsWith(normOid(ownTableOid) + '.');
  if ((t.table && ownTable && t.table !== ownTable) || outside) features.push(`cross-table tag from ${t.table ?? 'another table'}`);
  refs.push({
    oid: normOid(s.OID), ddName: s.name,
    role: ctx === 'global' ? 'global-tag' : 'column-tag',
    structure: ctx === 'table' ? 'table' : 'scalar',
    mib: t.MIB ?? mib, table: ownTable, tag: t.tag, mapping: t.mapping, features, source,
  });
}
