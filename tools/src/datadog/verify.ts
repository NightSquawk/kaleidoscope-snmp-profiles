/**
 * Accuracy checks for converted profiles.
 *
 *  A. Accounting: every Datadog OID reference lands in exactly one output
 *     entry or is dropped with a reason. Structural; must be 100%.
 *  B. Data parity (replay): Datadog keeps an snmpsim recording per profile.
 *     For each reference, would Datadog's agent get an answer from the
 *     recording, and would the converted entry? A reference Datadog answers
 *     and we do not is a conversion error.
 *  C. Type parity: for every entry that answers, the SNMP type on the wire
 *     (from the recording) against the entry's `type`.
 *  D. Identity: the recording's sysObjectID picks a profile under Datadog's
 *     matching rules and under ours; the two must agree.
 *  E. Schema: every output document against schema/profile.schema.json, plus
 *     the validator's per-profile rules (unique metricKey, slug length).
 */
import type { Conversion, KProfile } from './convert.js';
import type { DdProfile } from './load.js';
import { answer, type Recording } from './snmprec.js';
import { oidHasPrefix } from '../repo.js';

export interface ReplayResult {
  refs: number;
  ddAnswered: number;
  bothAnswered: number;
  /** Datadog answers, converted entry does not */
  lost: { oid: string; name: string; role: string; entry: string | null; why: string }[];
  /** dropped references that do answer in the recording */
  droppedButAnswered: { oid: string; name: string; reason: string }[];
  /** Datadog scalar answered only after appending .0 */
  ddNeededDot0: number;
  entriesAnswered: number;
  entries: number;
  typeMismatches: { oid: string; name: string; declared: string; wire: string }[];
}

/** Datadog agent's scalar fetch: GET as written, retry with `.0` when absent. */
function ddAnswer(rec: Recording, oid: string, table: boolean): { hit: string | null; dot0: boolean } {
  if (table) return { hit: answer(rec, oid, true), dot0: false };
  const exact = answer(rec, oid, false);
  if (exact || oid.endsWith('.0')) return { hit: exact, dot0: false };
  const retry = answer(rec, oid + '.0', false);
  return { hit: retry, dot0: !!retry };
}

/** Types that are the same thing on the wire for the platform. */
function typeCompatible(declared: string, wire: string): boolean {
  if (declared === wire) return true;
  // Integer32 vs Unsigned32/Gauge32: both numbers stored as-is; flagged separately only if string/number mix.
  const num = new Set(['integer', 'gauge']);
  return num.has(declared) && num.has(wire);
}

export function replay(conv: Conversion, rec: Recording): ReplayResult {
  const r: ReplayResult = {
    refs: conv.outcomes.length, ddAnswered: 0, bothAnswered: 0, lost: [], droppedButAnswered: [],
    ddNeededDot0: 0, entriesAnswered: 0, entries: conv.entries.size, typeMismatches: [],
  };
  for (const o of conv.outcomes) {
    const dd = ddAnswer(rec, o.ref.oid, o.ref.structure === 'table');
    if (!dd.hit) continue;
    r.ddAnswered++;
    if (dd.dot0) r.ddNeededDot0++;
    if (o.dropped) {
      r.droppedButAnswered.push({ oid: o.ref.oid, name: o.ref.ddName, reason: o.dropped });
      continue;
    }
    const e = conv.entries.get(o.entryKey!)!;
    if (answer(rec, e.oid, e.walk)) r.bothAnswered++;
    else r.lost.push({ oid: o.ref.oid, name: o.ref.ddName, role: o.ref.role, entry: `${e.walk ? 'walk' : 'get'} ${e.oid}`, why: 'converted entry does not answer' });
  }
  for (const e of conv.entries.values()) {
    const hit = answer(rec, e.oid, e.walk);
    if (!hit) continue;
    r.entriesAnswered++;
    const wire = rec.types.get(hit)!;
    if (!typeCompatible(e.type, wire)) r.typeMismatches.push({ oid: e.oid, name: e.name, declared: e.type, wire });
  }
  return r;
}

export function accounting(conv: Conversion, dd: DdProfile): string[] {
  const problems: string[] = [];
  if (conv.outcomes.length !== dd.refs.length) problems.push(`outcomes ${conv.outcomes.length} != refs ${dd.refs.length}`);
  for (const o of conv.outcomes) {
    if (!o.dropped && (!o.entryKey || !conv.entries.has(o.entryKey))) problems.push(`ref ${o.ref.oid} (${o.ref.ddName}) has no entry`);
  }
  const used = new Set(conv.outcomes.map(o => o.entryKey).filter(Boolean));
  for (const k of conv.entries.keys()) if (!used.has(k)) problems.push(`entry ${k} has no source reference`);
  return problems;
}

// ── Identity ────────────────────────────────────────────────────────────

/** Datadog: exact OID match or `prefix.*` wildcard; most arcs wins, exact beats wildcard on a tie. */
export function datadogWinner(sysObjectId: string, profiles: DdProfile[]): { ids: string[]; score: number } {
  let best = -1, ids: string[] = [];
  for (const p of profiles) {
    if (p.abstract) continue;
    let s = -1;
    for (const pat of p.sysobjectids) {
      if (pat.endsWith('.*')) {
        const pre = pat.slice(0, -2);
        if (sysObjectId.startsWith(pre + '.')) s = Math.max(s, pre.split('.').length);
      } else if (pat === sysObjectId) {
        s = Math.max(s, pat.split('.').length + 0.5);
      }
    }
    if (s < 0) continue;
    if (s > best) { best = s; ids = [p.id]; } else if (s === best) ids.push(p.id);
  }
  return { ids, score: best };
}

/** Kaleidoscope as specified: octet-anchored prefix, specificity = arcs of the longest matching pattern. */
export function kaleidoscopeWinner(sysObjectId: string, profiles: KProfile[]): { slugs: string[]; score: number } {
  let best = -1, slugs: string[] = [];
  for (const p of profiles) {
    const pats = [...p.matchPatterns, ...(p.matchAny ?? [])].map(m => m.pattern);
    let s = -1;
    for (const pat of pats) if (oidHasPrefix(sysObjectId, pat)) s = Math.max(s, pat.split('.').length);
    if (s < 0) continue;
    if (s > best) { best = s; slugs = [p.slug]; } else if (s === best) slugs.push(p.slug);
  }
  return { slugs, score: best };
}
