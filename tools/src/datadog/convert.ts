/**
 * Datadog profile → Kaleidoscope profile (docs/FORMAT.md, format 1).
 *
 * Rules, in the order they matter for accuracy:
 *
 *  1. Fetch semantics follow Datadog, facts follow the MIB. Datadog decides
 *     what is fetched and how (a `symbol` is a GET, a table column or tag
 *     column is a walk); libsmi over our mibs/ decides the object name, type,
 *     enumeration and row index. Disagreements are recorded, not guessed away.
 *  2. A Datadog scalar written without its `.0` instance gets `.0` appended
 *     when the MIB says the object is a scalar; that is what answers on the
 *     wire. A GET of one table row (`hrProcessorLoad.196608`) stays a GET of
 *     that exact instance. A GET of a bare table column, which never answers,
 *     becomes a walk.
 *  3. `extends` is flattened. Every inherited mixin's OIDs are copied in and
 *     the profile gets `extends: none`, because Kaleidoscope's curated
 *     parents poll a different OID set and the platform does not persist
 *     `extends` from repo imports yet.
 *  4. One OID entry per (OID, walk). All Datadog references that land on the
 *     same entry are merged into its `datadog` block, so nothing is lost.
 *  5. Every reference ends up either in an entry or in `dropped` with a
 *     reason. verify.ts checks that invariant.
 *  6. Datadog features the format cannot express (tag regexes, index tags,
 *     cross-table joins, extract_value, flag_stream bit positions, most
 *     scale factors, constant metrics, static metadata) are reported as
 *     losses per profile.
 */
import type { DdProfile, DdRef } from './load.js';
import type { MibIndex, MibObject } from './mibindex.js';
import { READABLE } from './mibindex.js';
import { PROFILE_CLASS, type Category } from './categories.js';
import { answer, type Recording } from './snmprec.js';
import { oidHasPrefix, type Manifest, type Registry } from '../repo.js';

export interface KOid {
  oid: string;
  name: string;
  metricKey: string;
  type: string;
  walk: boolean;
  cadenceTier: 'every-poll' | 'discovery';
  coalesceKey?: string[];
  transform?: string | null;
  enumMap?: Record<string, string> | null;
  /** provenance: how Datadog used this OID. Unknown key; the importer ignores it. */
  datadog: {
    as: string[];
    metric?: string[];
    metricType?: string[];
    tags?: string[];
    fields?: string[];
    features?: string[];
    from: string[];
  };
}

export interface KProfile {
  formatVersion: 1;
  slug: string;
  name: string;
  description: string;
  deviceCategory: Category;
  vendor: string | null;
  extends: 'none';
  priority: number;
  enabled: false;
  pollIntervalSeconds?: number;
  matchPatterns: { field: 'sysObjectId'; pattern: string }[];
  /** PROPOSED format key: device matches when ANY entry matches. See REPORT.md. */
  matchAny?: { field: 'sysObjectId'; pattern: string }[];
  metricsTemplate: Record<string, never>;
  oids: KOid[];
  origin: {
    source: 'datadog/integrations-core';
    file: string;
    commit: string | null;
    license: 'BSD-3-Clause';
    extends: string[];
  };
}

export type IssueCode =
  | 'unresolved'            // no MIB object; name and type come from Datadog
  | 'shape-mismatch'        // Datadog GETs a column or walks a scalar
  | 'instance-appended'     // scalar written without .0; .0 added
  | 'instance-guessed'      // unresolved device-level tag/field without .0; .0 added as the agent's retry does
  | 'row-instance-get'      // GET of one specific table row
  | 'type-from-recording'   // object or its SYNTAX unresolved; type is what Datadog's recording sends
  | 'type-from-datadog'     // object or its SYNTAX unresolved and not in a recording; type inferred from Datadog usage
  | 'name-alias'            // Datadog metric name differs from the MIB object name
  | 'metrickey-collision';  // two entries share a MIB name; key suffixed

export interface Issue { code: IssueCode; oid: string; detail: string }

export type DropReason =
  | 'not-accessible'        // INDEX column, never answers; Datadog tags from the row index instead
  ;

export interface RefOutcome { ref: DdRef; entryKey: string | null; dropped?: DropReason }

export interface Conversion {
  profile: KProfile;
  /** entry key (`G:oid` / `W:oid`) → entry */
  entries: Map<string, KOid>;
  outcomes: RefOutcome[];
  issues: Issue[];
  /** Datadog features that did not survive, one line each */
  losses: string[];
  /** path under profiles/ this file would live at */
  path: string;
}

const ACRONYMS: Record<string, string> = {
  apc: 'APC', ups: 'UPS', pdu: 'PDU', pdu3: 'PDU3', pdu4: 'PDU4', hp: 'HP', hpe: 'HPE', asa: 'ASA', asr: 'ASR', isr: 'ISR',
  wlc: 'WLC', ucs: 'UCS', ise: 'ISE', icm: 'ICM', uc: 'UC', sb: 'SB', ilo: 'iLO', ilo4: 'iLO 4', msa: 'MSA', ipam: 'IPAM',
  idrac: 'iDRAC', os10: 'OS10', dgs: 'DGS', fc: 'FC', h3c: 'H3C', icf: 'ICF', ex: 'EX', mx: 'MX', qfx: 'QFX', srx: 'SRX',
  sdx: 'SDX', esx: 'ESX', hsm: 'HSM', ac: 'AC', ent: 'Enterprise', ind: 'Industrial', wap: 'WAP', xgs: 'XGS', cj: 'CJ',
  ip: 'IP', a10: 'A10', '3com': '3Com', tp: 'TP', f5: 'F5', csr1000v: 'CSR1000v', ex2: 'EX2', emc: 'EMC', sbc: 'SBC',
  acs: 'ACS', aura: 'Aura', cx: 'CX', bladesystem: 'BladeSystem', netbotz: 'NetBotz', roomalert: 'Room Alert',
  netscaler: 'NetScaler', cloudgen: 'CloudGen', cloudgenix: 'CloudGenix', fortigate: 'FortiGate', fortiswitch: 'FortiSwitch',
  proliant: 'ProLiant', poweredge: 'PowerEdge', powerconnect: 'PowerConnect', sonicwall: 'SonicWall', readynas: 'ReadyNAS',
  truenas: 'TrueNAS', ixsystems: 'iXsystems', mycloud: 'My Cloud', edgeconnect: 'EdgeConnect', steelhead: 'SteelHead',
  switchx: 'SwitchX', unifi: 'UniFi', velocloud: 'VeloCloud', datapower: 'DataPower', ironport: 'IronPort',
  pf: 'pf', sense: 'Sense', silverpeak: 'Silver Peak', servertech: 'Server Technology', tripplite: 'Tripp Lite',
  mikrotik: 'MikroTik', opengear: 'Opengear', bluecat: 'BlueCat', exagrid: 'ExaGrid', netapp: 'NetApp', 'eagle-i': 'Eagle-I',
};

function displayName(id: string): string {
  return id.replace(/_/g, '-').split('-').map(w => ACRONYMS[w] ?? (w[0].toUpperCase() + w.slice(1))).join(' ')
    .replace('pf Sense', 'pfSense').replace('Tp Link', 'TP-Link').replace('Eagle I', 'Eagle-I');
}

export function slugFor(id: string, manifest: Manifest): string {
  const base = id.replace(/_/g, '-').toLowerCase();
  // generic-ups exists in the Kaleidoscope monorepo's curated set.
  return manifest.externalParents.includes(base) ? `${base}-datadog` : base;
}

/**
 * Type from how Datadog uses the OID, for objects whose MIB type is unknown:
 * forced metric_type first, then a numeric value mapping (an enum used as a
 * tag), then role (metrics are numbers, tags and metadata are strings).
 */
function typeFromDatadog(refs: DdRef[]): string {
  for (const r of refs) {
    switch (r.metricType) {
      case 'rate': case 'monotonic_count': case 'monotonic_count_and_rate': return 'counter';
      case 'gauge': case 'percent': return 'gauge';
      case 'flag_stream': return 'string';
    }
  }
  if (refs.some(r => r.mapping && Object.keys(r.mapping).every(k => /^-?\d+$/.test(k)))) return 'integer';
  if (refs.some(r => r.role === 'metric' && !r.features.some(f => f.startsWith('extract_value') || f.startsWith('match_pattern')))) return 'gauge';
  return 'string';
}

const WIRE_TYPES = new Set(['integer', 'string', 'oid', 'counter', 'gauge', 'timeticks']);

const POLL_INTERVAL: Partial<Record<Category, number>> = { ups: 300, printer: 900 };

const SCALE_TRANSFORM: Record<string, string> = { '0.1': 'divideBy10', '0.01': 'divideBy100' };

export function convertProfile(
  dd: DdProfile, mib: MibIndex, manifest: Manifest, registry: Registry, commit: string | null, sourceRoot: string,
  rec?: Recording,
): Conversion {
  const cls = PROFILE_CLASS[dd.id];
  if (!cls) throw new Error(`${dd.file}: no entry in datadog/categories.ts; classify it before converting`);

  const patterns = dedupePatterns(dd.sysobjectids.map(p => p.replace(/\.\*$/, '')));
  const row = registry.entries
    .filter(e => patterns.some(p => oidHasPrefix(p, e.oidPrefix)))
    .sort((a, b) => b.oidPrefix.split('.').length - a.oidPrefix.split('.').length)[0];
  const vendor = cls.vendor !== undefined ? cls.vendor : (row?.vendor ?? dd.vendorHint);

  const issues: Issue[] = [];
  const losses: string[] = [];
  const outcomes: RefOutcome[] = [];
  const entries = new Map<string, KOid>();
  const refsByKey = new Map<string, DdRef[]>();
  const facts = new Map<string, { obj: MibObject | null; instance?: string }>();

  // INDEX of each Datadog table, from its first MIB-resolved metric column.
  // A tag column with a different INDEX is joined from another table.
  const tableIndex = new Map<string, string>();
  for (const ref of dd.refs) {
    if (ref.role !== 'metric' || ref.structure !== 'table' || !ref.table) continue;
    const k = `${ref.source}|${ref.table}`;
    const idx = mib.resolve(ref.oid)?.entry.index;
    if (idx?.length && !tableIndex.has(k)) tableIndex.set(k, idx.join(','));
  }

  for (const ref of dd.refs) {
    const hit = mib.resolve(ref.oid);
    const obj = hit?.entry ?? null;

    if (obj && !READABLE.has(obj.access)) {
      outcomes.push({ ref, entryKey: null, dropped: 'not-accessible' });
      losses.push(`not-accessible ${obj.name} (${ref.oid}, ${obj.access}) used as ${ref.role}${ref.tag ? ` tag ${ref.tag}` : ''}: value is the row index, which the format cannot tag with`);
      continue;
    }

    let oid = ref.oid;
    let walk = ref.structure === 'table';
    let exactObj = !!hit && hit.form !== 'indexed';
    let features = ref.features;
    if (ref.role === 'column-tag' && obj?.index?.length && ref.table) {
      const own = tableIndex.get(`${ref.source}|${ref.table}`);
      const cross = features.some(f => f.startsWith('cross-table'));
      if (own && own === obj.index.join(',')) {
        // Same INDEX (or AUGMENTS, e.g. ifXTable on ifTable): coalesceKey joins them.
        if (cross) features = features.filter(f => !f.startsWith('cross-table'));
      } else if (own && !cross) {
        features = [...features, `cross-table tag from ${obj.name}'s table (INDEX ${obj.index.join(', ')} vs ${own})`];
      }
    }
    if (hit) {
      if (!walk && hit.form === 'no-instance') {
        oid = obj!.oid;
        issues.push({ code: 'instance-appended', oid: ref.oid, detail: `${obj!.name}: scalar written without .0` });
      } else if (!walk && hit.form === 'indexed' && hit.instance!.split('.').length < (obj!.index?.length ?? 1)) {
        // Every INDEX object takes at least one arc; a shorter instance never answers.
        oid = obj!.oid;
        walk = true;
        exactObj = true;
        issues.push({ code: 'shape-mismatch', oid: ref.oid, detail: `Datadog GETs ${obj!.name}.${hit.instance}, shorter than INDEX { ${obj!.index!.join(', ')} }; walked instead` });
      } else if (!walk && hit.form === 'indexed' && hit.instance!.split('.')[0] === '0'
        && obj!.index?.length && mib.named(obj!.index[0], obj!.module)?.type === 'string') {
        // A leading 0 on a string INDEX is the empty string: no row is named "" (NS-ROOT svcServiceName, WLSX haProfileName).
        oid = obj!.oid;
        walk = true;
        exactObj = true;
        issues.push({ code: 'shape-mismatch', oid: ref.oid, detail: `Datadog GETs ${obj!.name}.${hit.instance}, an empty ${obj!.index[0]} string; walked instead` });
      } else if (!walk && hit.form === 'indexed') {
        issues.push({ code: 'row-instance-get', oid: ref.oid, detail: `${obj!.name} row ${hit.instance}` });
      } else if (walk && !obj!.walk) {
        issues.push({ code: 'shape-mismatch', oid: ref.oid, detail: `Datadog walks ${obj!.name}, MIB defines a scalar` });
      } else if (!walk && hit.form === 'exact' && obj!.walk) {
        // A GET of a bare column answers nothing on a real agent, with or
        // without the `.0` retry. Walk it, which is what the metric needs.
        walk = true;
        issues.push({ code: 'shape-mismatch', oid: ref.oid, detail: `Datadog GETs column ${obj!.name} with no instance; walked instead` });
      } else if (walk && hit.form !== 'exact') {
        issues.push({ code: 'shape-mismatch', oid: ref.oid, detail: `Datadog walks ${ref.oid}, MIB object is ${obj!.name} at ${obj!.oid}` });
      }
    } else {
      issues.push({ code: 'unresolved', oid: ref.oid, detail: `${ref.ddName}${ref.mib ? ` (${ref.mib})` : ''}` });
      // Datadog's agent GETs a scalar as written and retries with `.0`. For
      // device-level tags and metadata the `.0` form is the one that answers;
      // row-instance metric GETs (`…1.6.1`) are left alone.
      if (!walk && !oid.endsWith('.0') && (ref.role === 'global-tag' || ref.field?.startsWith('device.'))) {
        // A sibling column GET with a row instance (`…1.6.1` next to `…1.2`) means this is a column
        // too, and which row the device has is unknown: walk it instead of guessing `.0`.
        const parent = oid.slice(0, oid.lastIndexOf('.'));
        const column = dd.refs.some(r => r.structure === 'scalar' && r.oid !== oid && r.oid.startsWith(parent + '.')
          && r.oid.slice(parent.length + 1).split('.').length >= 2 && !r.oid.endsWith('.0'));
        if (column) {
          walk = true;
          issues.push({ code: 'instance-guessed', oid: ref.oid, detail: `${ref.ddName}: no MIB object; a sibling column is read by row, so walked` });
        } else {
          oid = `${oid}.0`;
          issues.push({ code: 'instance-guessed', oid: ref.oid, detail: `${ref.ddName}: no MIB object, .0 appended` });
        }
      }
    }

    const key = `${walk ? 'W' : 'G'}:${oid}`;
    outcomes.push({ ref, entryKey: key });
    refsByKey.set(key, [...(refsByKey.get(key) ?? []), ref]);
    // The exact-object hit is the one whose facts describe this fetch.
    if (!facts.has(key)) {
      facts.set(key, {
        obj: exactObj || (hit?.form === 'indexed' && !walk) ? obj : null,
        instance: hit?.form === 'indexed' && !walk ? hit.instance : undefined,
      });
    }

    for (const f of features) losses.push(`${f} on ${ref.ddName} (${ref.oid}, ${ref.role})`);
  }
  for (const n of dd.nonOid) losses.push(`${n.kind}: ${n.detail} [${n.source}]`);

  // Build entries in first-reference order.
  const keyCount = new Map<string, number>();
  for (const [key, refs] of refsByKey) {
    const walk = key.startsWith('W:');
    const oid = key.slice(2);
    const { obj, instance } = facts.get(key)!;
    const name = obj?.name ?? refs[0].ddName;
    // Without a MIB type, what the device simulator sends beats a guess from usage
    // (Datadog's agent itself types values from the wire: a Counter32 becomes a rate).
    const hit = !obj?.typeKnown && rec ? answer(rec, oid, walk) : null;
    const wire = hit ? rec!.types.get(hit) : undefined;
    const fromWire = wire && WIRE_TYPES.has(wire) ? wire : null;
    const type = obj?.typeKnown ? obj.type : fromWire ?? typeFromDatadog(refs);
    if (!obj?.typeKnown) issues.push({ code: fromWire ? 'type-from-recording' : 'type-from-datadog', oid, detail: `${name}: ${type}` });

    const aliases = [...new Set(refs.filter(r => r.role === 'metric' && r.ddName !== name).map(r => r.ddName))];
    if (obj && aliases.length) issues.push({ code: 'name-alias', oid, detail: `${name} as ${aliases.join(', ')}` });

    // Column tags label live rows (alarm tables, SMART status); Datadog re-reads them every run.
    const live = refs.some(r => r.role === 'metric' || r.role === 'column-tag' || r.mapping);
    const numeric = ['integer', 'gauge', 'counter', 'timeticks'].includes(type);
    const mapping = refs.find(r => r.mapping)?.mapping;
    const ddEnum = mapping && Object.keys(mapping).every(k => /^-?\d+$/.test(k))
      ? Object.fromEntries(Object.entries(mapping).map(([k, v]) => [k, String(v)])) : null;
    const scales = [...new Set(refs.flatMap(r => r.features.filter(f => f.startsWith('scale_factor=')).map(f => f.slice(13))))];
    const transform = scales.length === 1 ? (SCALE_TRANSFORM[scales[0]] ?? null) : null;

    const n = (keyCount.get(name) ?? 0) + 1;
    keyCount.set(name, n);

    const entry: Omit<KOid, 'datadog'> & Partial<Pick<KOid, 'datadog'>> = {
      // A single-row GET is keyed by its row so it never shadows the column's own key.
      oid, name, metricKey: instance ? `${name}_${instance.replace(/\./g, '_')}` : name, type, walk,
      cadenceTier: live || (numeric && refs.every(r => r.role !== 'metadata' && r.role !== 'global-tag')) ? 'every-poll' : 'discovery',
    };
    if (walk && obj?.index?.length) entry.coalesceKey = obj.index;
    if (transform) entry.transform = transform;
    if (obj?.bitmask) {
      // enumMap maps exact values; a bit-mask reading like 5 or 1152 would show as unmapped.
      losses.push(`bitmask enumeration on ${name} (${oid}): combined values cannot be labelled with enumMap`);
    } else {
      const enumMap = obj?.enumMap ?? ddEnum;
      if (enumMap) entry.enumMap = enumMap;
    }
    entry.datadog = compact({
      as: [...new Set(refs.map(r => r.role))],
      metric: aliases,
      metricType: [...new Set(refs.map(r => r.metricType).filter((x): x is string => !!x))],
      tags: [...new Set(refs.map(r => r.tag).filter((x): x is string => !!x))],
      fields: [...new Set(refs.map(r => r.field).filter((x): x is string => !!x))],
      features: [...new Set(refs.flatMap(r => r.features))],
      from: [...new Set(refs.map(r => r.source))],
    });
    entries.set(key, entry as KOid);
  }

  // metricKey must be unique: suffix repeats with the instance or the arc.
  const byKey = new Map<string, KOid[]>();
  for (const e of entries.values()) byKey.set(e.metricKey, [...(byKey.get(e.metricKey) ?? []), e]);
  for (const [k, list] of byKey) {
    if (list.length < 2) continue;
    for (const e of list.slice(1)) {
      const suffix = e.walk ? 'walk' : e.oid.split('.').slice(-2).join('_');
      e.metricKey = `${k}_${suffix}`;
      issues.push({ code: 'metrickey-collision', oid: e.oid, detail: `${k} → ${e.metricKey}` });
    }
  }

  const slug = slugFor(dd.id, manifest);
  const sp = patterns.map(pattern => ({ field: 'sysObjectId' as const, pattern }));
  const profile: KProfile = {
    formatVersion: 1,
    slug,
    name: displayName(dd.id),
    description: `Converted from Datadog's ${dd.file} SNMP profile. Untested in Kaleidoscope.`,
    deviceCategory: cls.category,
    vendor,
    extends: 'none',
    priority: 5,
    enabled: false,
    ...(POLL_INTERVAL[cls.category] ? { pollIntervalSeconds: POLL_INTERVAL[cls.category] } : {}),
    matchPatterns: sp.length === 1 ? sp : [],
    ...(sp.length > 1 ? { matchAny: sp } : {}),
    metricsTemplate: {},
    oids: [...entries.values()],
    origin: {
      source: 'datadog/integrations-core',
      file: `${sourceRoot}/${dd.file}`,
      commit,
      license: 'BSD-3-Clause',
      extends: dd.ancestors,
    },
  };

  const vendorDir = (vendor ?? 'generic').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return {
    profile, entries, outcomes, issues, losses: [...new Set(losses)],
    path: `profiles/${cls.category}/${vendorDir}/${slug}.yaml`,
  };
}

/** Drop patterns covered by a shorter pattern in the same list (octet-anchored). */
function dedupePatterns(list: string[]): string[] {
  const uniq = [...new Set(list)];
  return uniq.filter(p => !uniq.some(q => q !== p && oidHasPrefix(p, q)));
}

function compact<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => !(Array.isArray(v) && v.length === 0))) as T;
}
