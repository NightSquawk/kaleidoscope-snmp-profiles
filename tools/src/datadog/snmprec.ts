/**
 * snmpsim `.snmprec` recordings: `oid|type|value`, one per line.
 * Datadog keeps one per profile in integrations-core snmp/tests/compose/data,
 * named after the profile. We replay them to check that a converted profile
 * fetches the same data the Datadog profile does.
 */
import { readFile } from 'node:fs/promises';

/** snmprec / BER application tags → Kaleidoscope oid type. */
const TAG_TYPE: Record<string, string> = {
  '2': 'integer',
  '4': 'string',
  '5': 'null',
  '6': 'oid',
  '64': 'string',     // IpAddress, stored as a string by the platform
  '65': 'counter',    // Counter32
  '66': 'gauge',      // Gauge32 / Unsigned32
  '67': 'timeticks',
  '68': 'string',     // Opaque
  '70': 'counter',    // Counter64
};

export interface Recording {
  /** sorted numerically so prefix scans are contiguous */
  oids: string[];
  types: Map<string, string>;
  values: Map<string, string>;
  sysObjectId: string | null;
}

export async function loadRecording(path: string): Promise<Recording> {
  const types = new Map<string, string>();
  const values = new Map<string, string>();
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const a = line.indexOf('|');
    const b = line.indexOf('|', a + 1);
    if (a < 0 || b < 0) continue;
    const oid = line.slice(0, a).replace(/^\./, '');
    // tag may carry a suffix: `4x` hex-encoded, `4:variation`
    const tag = line.slice(a + 1, b).replace(/[^0-9].*$/, '');
    types.set(oid, TAG_TYPE[tag] ?? `tag${tag}`);
    values.set(oid, line.slice(b + 1));
  }
  const oids = [...types.keys()].sort(compareOid);
  return { oids, types, values, sysObjectId: values.get('1.3.6.1.2.1.1.2.0')?.replace(/^\./, '') ?? null };
}

export function compareOid(a: string, b: string): number {
  const x = a.split('.'), y = b.split('.');
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d) return d;
  }
  return x.length - y.length;
}

/** First recorded OID strictly under `prefix`, or null. Binary search. */
export function firstUnder(rec: Recording, prefix: string): string | null {
  let lo = 0, hi = rec.oids.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareOid(rec.oids[mid], prefix) <= 0) lo = mid + 1; else hi = mid;
  }
  const hit = rec.oids[lo];
  return hit && hit.startsWith(prefix + '.') ? hit : null;
}

/**
 * What a poller would get back.
 * - GET (walk=false): exact OID.
 * - WALK (walk=true): first row under the column.
 * Returns the answering OID or null.
 */
export function answer(rec: Recording, oid: string, walk: boolean): string | null {
  if (walk) return firstUnder(rec, oid);
  return rec.types.has(oid) ? oid : null;
}
