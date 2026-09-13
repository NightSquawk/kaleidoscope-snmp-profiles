/**
 * Defining-module lookup over the compiled dictionaries. Datadog names a MIB
 * module on metrics but not on tag or metadata symbols, so the converter asks
 * the dictionaries which module defines those OIDs before building its MIB
 * index (see mibindex.ts).
 */
import { join } from 'node:path';
import { REPO_ROOT, loadJson, walkFiles } from '../repo.js';

interface DictFile { oids?: { oid: string; walk: boolean; module?: string }[] }

/** Module names defining any of `oids` (exact, `.0` added, or an enclosing column). */
export async function modulesForOids(oids: Iterable<string>, dir = join(REPO_ROOT, 'dictionaries')): Promise<Set<string>> {
  const wanted = new Set<string>();
  for (const oid of oids) {
    wanted.add(oid);
    wanted.add(oid + '.0');
    const arcs = oid.split('.');
    for (let n = arcs.length - 1; n > 6 && n >= arcs.length - 16; n--) wanted.add(arcs.slice(0, n).join('.'));
  }
  const found = new Set<string>();
  for (const f of await walkFiles(dir, ['.json'])) {
    const doc = await loadJson<DictFile>(f);
    for (const o of doc.oids ?? []) if (o.module && wanted.has(o.oid)) found.add(o.module);
  }
  return found;
}
