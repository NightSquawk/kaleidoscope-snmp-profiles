/**
 * Conversion rules, one test each. Uses hand-built Datadog profiles and a
 * hand-built MIB index, so no smidump or network is needed.
 *
 *   pnpm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDatadogProfiles } from './load.js';
import { MibIndex, type MibObject } from './mibindex.js';
import { convertProfile } from './convert.js';
import { PROFILE_CLASS } from './categories.js';
import { accounting, datadogWinner, kaleidoscopeWinner, replay } from './verify.js';
import type { Recording } from './snmprec.js';
import { compareOid } from './snmprec.js';
import type { Manifest, Registry } from '../repo.js';

const manifest = { externalParents: ['generic-ups'], defaultParents: {} } as unknown as Manifest;
const registry: Registry = { formatVersion: 1, entries: [{ oidPrefix: '1.3.6.1.4.1.99999', vendor: 'Acme', deviceCategory: 'switch' }] };

const obj = (o: Partial<MibObject> & Pick<MibObject, 'oid' | 'name'>): MibObject =>
  ({ module: 'ACME-MIB', type: 'integer', walk: false, enumMap: null, typeKnown: true, access: 'readonly', ...o });

const MIB = new MibIndex(new Map([
  obj({ oid: '1.3.6.1.2.1.1.5.0', name: 'sysName', type: 'string' }),
  obj({ oid: '1.3.6.1.4.1.99999.1.1.0', name: 'acmeTemp', type: 'gauge' }),
  obj({ oid: '1.3.6.1.4.1.99999.2.1.1.1', name: 'acmeFanIndex', walk: true, access: 'noaccess', index: ['acmeFanIndex'] }),
  obj({ oid: '1.3.6.1.4.1.99999.2.1.1.2', name: 'acmeFanName', type: 'string', walk: true, index: ['acmeFanIndex'] }),
  obj({ oid: '1.3.6.1.4.1.99999.2.1.1.3', name: 'acmeFanStatus', walk: true, index: ['acmeFanIndex'], enumMap: { 1: 'ok', 2: 'failed' } }),
  obj({ oid: '1.3.6.1.4.1.99999.3.1.1.1', name: 'acmeCpuLoad', type: 'gauge', walk: true, index: ['acmeCpuIndex'] }),
  obj({ oid: '1.3.6.1.4.1.99999.4.1.0', name: 'acmeBroken', type: 'string', typeKnown: false }),
  obj({ oid: '1.3.6.1.4.1.99999.5.1.1.6', name: 'acmeSensorTemp', walk: true, index: ['acmePortId', 'acmeSensorId'] }),
  obj({ oid: '1.3.6.1.4.1.99999.7.1.1.1', name: 'acmeSvcName', type: 'string', walk: true, access: 'noaccess', index: ['acmeSvcName'] }),
  obj({ oid: '1.3.6.1.4.1.99999.7.1.1.2', name: 'acmeSvcClients', type: 'gauge', walk: true, index: ['acmeSvcName'] }),
  obj({ oid: '1.3.6.1.4.1.99999.6.1.0', name: 'acmeFaults', enumMap: { 1: 'fan', 2: 'psu', 4: 'temp' }, bitmask: true }),
].map(o => [o.oid, o])));

async function profiles(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'dd-'));
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  return loadDatadogProfiles(dir);
}

function convert(ps: Awaited<ReturnType<typeof profiles>>, file: string) {
  const id = file.replace(/\.yaml$/, '');
  PROFILE_CLASS[id] ??= { category: 'switch' };
  return convertProfile(ps.get(file)!, MIB, manifest, registry, 'abc', 'default_profiles');
}

test('extends: base metrics first, child metadata field overrides base', async () => {
  const ps = await profiles({
    '_base.yaml': 'metrics:\n  - MIB: X\n    symbol: {OID: 1.3.6.1.2.1.1.5.0, name: sysName}\nmetadata:\n  device:\n    fields:\n      vendor: {value: base}\n',
    'acme.yaml': 'extends: [_base.yaml]\nsysobjectid: 1.3.6.1.4.1.99999.1.*\nmetadata:\n  device:\n    fields:\n      vendor: {value: acme}\nmetrics:\n  - MIB: ACME-MIB\n    symbol: {OID: 1.3.6.1.4.1.99999.1.1.0, name: acmeTemp}\n',
  });
  const p = ps.get('acme.yaml')!;
  assert.deepEqual(p.ancestors, ['_base.yaml']);
  assert.deepEqual(p.refs.map(r => r.ddName), ['sysName', 'acmeTemp']);
  assert.deepEqual(p.nonOid.map(n => n.detail), ['device.vendor = "acme"']);
  assert.equal(p.vendorHint, 'acme');
  assert.equal(ps.get('_base.yaml')!.abstract, true);
});

test('sysobjectid: wildcard becomes a prefix; covered patterns dropped; lists become matchAny', async () => {
  const ps = await profiles({
    'one.yaml': 'sysobjectid: 1.3.6.1.4.1.99999.1.*\nmetrics:\n  - symbol: {OID: 1.3.6.1.4.1.99999.1.1.0, name: acmeTemp}\n',
    'many.yaml': 'sysobjectid:\n  - 1.3.6.1.4.1.99999.5.*\n  - 1.3.6.1.4.1.99999.5.7\n  - 1.3.6.1.4.1.99999.6\nmetrics:\n  - symbol: {OID: 1.3.6.1.4.1.99999.1.1.0, name: acmeTemp}\n',
  });
  const one = convert(ps, 'one.yaml').profile;
  assert.deepEqual(one.matchPatterns, [{ field: 'sysObjectId', pattern: '1.3.6.1.4.1.99999.1' }]);
  assert.equal(one.matchAny, undefined);
  const many = convert(ps, 'many.yaml').profile;
  assert.deepEqual(many.matchPatterns, []);
  assert.deepEqual(many.matchAny!.map(m => m.pattern), ['1.3.6.1.4.1.99999.5', '1.3.6.1.4.1.99999.6']);
});

test('scalar without .0 gets .0 from the MIB; a row-instance GET stays exact; a bare column GET is walked', async () => {
  const ps = await profiles({
    'a.yaml': 'sysobjectid: 1.3.6.1.4.1.99999.1\nmetrics:\n  - symbol: {OID: 1.3.6.1.4.1.99999.1.1, name: temperature}\n  - symbol: {OID: 1.3.6.1.4.1.99999.3.1.1.1.196608, name: cpu.usage}\n  - symbol: {OID: 1.3.6.1.4.1.99999.2.1.1.3, name: fan.status}\n',
  });
  const c = convert(ps, 'a.yaml');
  const [temp, cpu, fan] = c.profile.oids;
  assert.equal(fan.walk, true);
  assert.deepEqual(fan.coalesceKey, ['acmeFanIndex']);
  assert.ok(c.issues.some(i => i.code === 'shape-mismatch'));
  assert.equal(temp.oid, '1.3.6.1.4.1.99999.1.1.0');
  assert.equal(temp.name, 'acmeTemp');
  assert.deepEqual(temp.datadog.metric, ['temperature']);
  assert.equal(cpu.oid, '1.3.6.1.4.1.99999.3.1.1.1.196608');
  assert.equal(cpu.walk, false);
  assert.equal(cpu.name, 'acmeCpuLoad');
  assert.ok(c.issues.some(i => i.code === 'instance-appended'));
  assert.ok(c.issues.some(i => i.code === 'row-instance-get'));
});

test('tables: columns walked with the row INDEX; tag columns merged; not-accessible index dropped', async () => {
  const ps = await profiles({
    't.yaml': [
      'sysobjectid: 1.3.6.1.4.1.99999.1',
      'metrics:',
      '  - MIB: ACME-MIB',
      '    table: {OID: 1.3.6.1.4.1.99999.2.1, name: acmeFanTable}',
      '    symbols:',
      '      - {OID: 1.3.6.1.4.1.99999.2.1.1.3, name: acmeFanStatus}',
      '      - {name: acmeFan, constant_value_one: true}',
      '    metric_tags:',
      '      - {tag: fan, symbol: {OID: 1.3.6.1.4.1.99999.2.1.1.2, name: acmeFanName}}',
      '      - {tag: fan_status, symbol: {OID: 1.3.6.1.4.1.99999.2.1.1.3, name: acmeFanStatus}, mapping: {1: ok, 2: failed}}',
      '      - {tag: fan_idx, symbol: {OID: 1.3.6.1.4.1.99999.2.1.1.1, name: acmeFanIndex}}',
      '      - {tag: fan_pos, index: 1}',
      '',
    ].join('\n'),
  });
  const p = ps.get('t.yaml')!;
  const c = convert(ps, 't.yaml');
  assert.deepEqual(accounting(c, p), []);
  assert.deepEqual(c.profile.oids.map(o => o.name), ['acmeFanStatus', 'acmeFanName']);
  const status = c.profile.oids[0];
  assert.equal(status.walk, true);
  assert.deepEqual(status.coalesceKey, ['acmeFanIndex']);
  assert.deepEqual(status.datadog.as, ['metric', 'column-tag']);
  assert.deepEqual(status.enumMap, { 1: 'ok', 2: 'failed' });
  assert.equal(c.profile.oids[1].cadenceTier, 'every-poll', 'tag columns label live rows');
  assert.deepEqual(c.outcomes.filter(o => o.dropped).map(o => o.ref.ddName), ['acmeFanIndex']);
  assert.ok(c.losses.some(l => l.startsWith('index-tag')));
  assert.ok(c.losses.some(l => l.startsWith('constant-metric')));
});

test('instance shorter than a multi-part INDEX is walked; tag from another INDEX is a cross-table loss; bit masks lose enumMap', async () => {
  const ps = await profiles({
    'x.yaml': [
      'sysobjectid: 1.3.6.1.4.1.99999.1',
      'metrics:',
      '  - symbol: {OID: 1.3.6.1.4.1.99999.5.1.1.6.0, name: sensor.temp}',
      '  - symbol: {OID: 1.3.6.1.4.1.99999.6.1.0, name: faults}',
      '  - symbol: {OID: 1.3.6.1.4.1.99999.7.1.1.2.0, name: svc.clients}',
      '  - symbol: {OID: 1.3.6.1.4.1.99999.9.1.6.1, name: cpu.usage}',
      '  - table: {OID: 1.3.6.1.4.1.99999.2.1, name: acmeFanTable}',
      '    symbols: [{OID: 1.3.6.1.4.1.99999.2.1.1.3, name: acmeFanStatus}]',
      '    metric_tags:',
      '      - {tag: cpu, symbol: {OID: 1.3.6.1.4.1.99999.3.1.1.1, name: acmeCpuLoad}}',
      '      - {tag: fan, table: otherTable, symbol: {OID: 1.3.6.1.4.1.99999.2.1.1.2, name: acmeFanName}}',
      'metric_tags:',
      '  - {tag: monitoring, OID: 1.3.6.1.4.1.99999.9.1.2, symbol: acmeCpuMonitoring}',
      '',
    ].join('\n'),
  });
  const c = convert(ps, 'x.yaml');
  const temp = c.profile.oids[0];
  assert.equal(temp.oid, '1.3.6.1.4.1.99999.5.1.1.6');
  assert.equal(temp.walk, true);
  assert.deepEqual(temp.coalesceKey, ['acmePortId', 'acmeSensorId']);
  assert.ok(c.losses.some(l => l.startsWith('cross-table') && l.includes('acmeCpuLoad')));
  assert.ok(!c.losses.some(l => l.includes('acmeFanName')), 'same INDEX joins through coalesceKey');
  const clients = c.profile.oids.find(o => o.name === 'acmeSvcClients')!;
  assert.equal(clients.walk, true, '.0 on a string INDEX is the empty string');
  assert.equal(clients.oid, '1.3.6.1.4.1.99999.7.1.1.2');
  assert.ok(c.profile.oids.some(o => o.oid === '1.3.6.1.4.1.99999.9.1.2' && o.walk), 'unresolved tag beside a row GET is a column: walked, not .0');
  const faults = c.profile.oids.find(o => o.name === 'acmeFaults')!;
  assert.equal(faults.enumMap, undefined, 'bit-mask values combine; enumMap would leave them unmapped');
  assert.ok(c.losses.some(l => l.startsWith('bitmask') && l.includes('acmeFaults')));
});

test('unknown MIB type falls back to Datadog usage; numeric mapping means integer', async () => {
  const ps = await profiles({
    'u.yaml': [
      'sysobjectid: 1.3.6.1.4.1.99999.1',
      'metrics:',
      '  - symbol: {OID: 1.3.6.1.4.1.99999.4.1.0, name: acmeBroken}',
      '    metric_type: monotonic_count',
      'metric_tags:',
      '  - {tag: mode, OID: 1.3.6.1.4.1.99999.9.9, symbol: acmeMode, mapping: {1: a, 2: b}}',
      '',
    ].join('\n'),
  });
  const c = convert(ps, 'u.yaml');
  const [broken, mode] = c.profile.oids;
  assert.equal(broken.type, 'counter');
  assert.equal(mode.type, 'integer');
  assert.equal(mode.oid, '1.3.6.1.4.1.99999.9.9.0', 'unresolved device-level tag gets the agent\'s .0 retry');
  assert.equal(mode.cadenceTier, 'every-poll');
});

test('unknown MIB type: the recording\'s wire type beats the usage guess; MIB types are never overridden', async () => {
  const ps = await profiles({
    'w.yaml': 'sysobjectid: 1.3.6.1.4.1.99999.1\nmetrics:\n  - table: {OID: 1.3.6.1.4.1.99999.8.1, name: t}\n    symbols: [{OID: 1.3.6.1.4.1.99999.8.1.1.2, name: hits}, {OID: 1.3.6.1.4.1.99999.8.1.1.3, name: misses}]\n  - symbol: {OID: 1.3.6.1.4.1.99999.1.1.0, name: acmeTemp}\n',
  });
  const data: [string, string][] = [['1.3.6.1.4.1.99999.8.1.1.2.7', 'counter'], ['1.3.6.1.4.1.99999.1.1.0', 'string']];
  const rec: Recording = { oids: data.map(d => d[0]).sort(compareOid), types: new Map(data), values: new Map(), sysObjectId: null };
  PROFILE_CLASS['w'] ??= { category: 'switch' };
  const c = convertProfile(ps.get('w.yaml')!, MIB, manifest, registry, null, 'x', rec);
  const [hits, misses, temp] = c.profile.oids;
  assert.equal(hits.type, 'counter');
  assert.equal(misses.type, 'gauge', 'not in the recording: usage guess');
  assert.equal(temp.type, 'gauge', 'MIB type wins over a wrong recording');
  assert.deepEqual(c.issues.filter(i => i.code.startsWith('type-from')).map(i => i.code), ['type-from-recording', 'type-from-datadog']);
});

test('slug avoids the monorepo curated set; metricKey collisions are suffixed', async () => {
  const ps = await profiles({
    'generic-ups.yaml': 'sysobjectid: 1.3.6.1.2.1.33\nmetrics:\n  - symbol: {OID: 1.3.6.1.4.1.99999.3.1.1.1.1, name: cpu.usage}\n  - symbol: {OID: 1.3.6.1.4.1.99999.3.1.1.1.2, name: cpu.usage}\n',
  });
  PROFILE_CLASS['generic-ups'] ??= { category: 'ups', vendor: null };
  const c = convertProfile(ps.get('generic-ups.yaml')!, MIB, manifest, registry, null, 'x');
  assert.equal(c.profile.slug, 'generic-ups-datadog');
  assert.deepEqual(c.profile.oids.map(o => o.metricKey), ['acmeCpuLoad_1', 'acmeCpuLoad_2']);
});

test('replay: Datadog scalar retry with .0; a dropped reference that answers is reported', async () => {
  const ps = await profiles({
    'r.yaml': 'sysobjectid: 1.3.6.1.4.1.99999.1\nmetrics:\n  - symbol: {OID: 1.3.6.1.4.1.99999.1.1, name: acmeTemp}\n  - table: {OID: 1.3.6.1.4.1.99999.2.1, name: t}\n    symbols: [{OID: 1.3.6.1.4.1.99999.2.1.1.3, name: acmeFanStatus}]\n    metric_tags: [{tag: i, symbol: {OID: 1.3.6.1.4.1.99999.2.1.1.1, name: acmeFanIndex}}]\n',
  });
  const c = convert(ps, 'r.yaml');
  const data: [string, string][] = [
    ['1.3.6.1.4.1.99999.1.1.0', 'gauge'], ['1.3.6.1.4.1.99999.2.1.1.1.4', 'integer'], ['1.3.6.1.4.1.99999.2.1.1.3.4', 'string'],
  ];
  const rec: Recording = { oids: data.map(d => d[0]).sort(compareOid), types: new Map(data), values: new Map(), sysObjectId: null };
  const r = replay(c, rec);
  assert.equal(r.ddNeededDot0, 1);
  assert.equal(r.lost.length, 0);
  assert.deepEqual(r.droppedButAnswered.map(d => d.name), ['acmeFanIndex']);
  assert.deepEqual(r.typeMismatches.map(t => t.name), ['acmeFanStatus']);
});

test('identity: Datadog `X.*` excludes X itself; our prefix includes it (known difference)', async () => {
  const ps = await profiles({
    'parent.yaml': 'sysobjectid: 1.3.6.1.4.1.99999.*\nmetrics:\n  - symbol: {OID: 1.3.6.1.4.1.99999.1.1.0, name: acmeTemp}\n',
    'child.yaml': 'sysobjectid: 1.3.6.1.4.1.99999.1.*\nmetrics:\n  - symbol: {OID: 1.3.6.1.4.1.99999.1.1.0, name: acmeTemp}\n',
  });
  const dd = [...ps.values()];
  const ours = [convert(ps, 'parent.yaml').profile, convert(ps, 'child.yaml').profile];
  assert.deepEqual(datadogWinner('1.3.6.1.4.1.99999.1.5', dd).ids, ['child']);
  assert.deepEqual(kaleidoscopeWinner('1.3.6.1.4.1.99999.1.5', ours).slugs, ['child']);
  assert.deepEqual(datadogWinner('1.3.6.1.4.1.99999.1', dd).ids, ['parent']);
  assert.deepEqual(kaleidoscopeWinner('1.3.6.1.4.1.99999.1', ours).slugs, ['child']);
});
