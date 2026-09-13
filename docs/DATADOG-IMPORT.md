# Converting Datadog SNMP profiles

Status 2026-09-13: all 162 Datadog device profiles are imported into `profiles/`, from integrations-core `47ac6e1950cd`. That happened after the accuracy checks below and a spot check of 11 profiles against MIB source (see "Spot check"). Every imported profile is `enabled: false` and untested on Kaleidoscope. The license is in `NOTICE`. The "Before enabling" section lists what still blocks turning them on.

## Why

[DataDog/integrations-core](https://github.com/DataDog/integrations-core) (BSD-3-Clause) ships 162 device profiles and 78 mixins under `snmp/datadog_checks/snmp/data/default_profiles/`. It ships no MIB files. What it adds over this repo is curation: which few dozen OIDs matter per device. This repo already held far more raw MIB data, but `profiles/` was empty.

## Running it

```bash
git clone --depth 1 https://github.com/DataDog/integrations-core /tmp/dd-ic   # or a sparse checkout of snmp/
cd tools
pnpm import:datadog --source /tmp/dd-ic --out /tmp/dd-out    # dry run; --out must be outside the repo root
pnpm test                                                    # conversion rules, no smidump needed
```

To refresh `profiles/` after a clean run, replace only the converted files: `rm -r profiles/*/` then `cp -r /tmp/dd-out/profiles/. profiles/`. Keep `profiles/README.md`, and update `NOTICE` and the `manifest.yaml` revision if the set changes. The tool refuses to write into the repository directly.

The report lands in `tools/.cache/datadog/report/REPORT.md` (plus `results.json`). The first run dumps about 700 MIB files with libsmi to build `tools/.cache/datadog/mib-index.json`; later runs use the cache. If a `smidump` wrapper on your PATH cannot see this checkout, set `SMIDUMP="$PWD/bin/smidump-docker"`.

Code: `tools/src/import-datadog.ts` (CLI and report), `tools/src/datadog/` (`load` Datadog YAML and `extends`, `mibindex` libsmi facts, `convert`, `verify`, `snmprec`, `categories`).

## Conversion rules

1. **Fetch semantics follow Datadog; facts follow the MIB.** A Datadog `symbol` is a GET, a table column or tag column is a walk. Object name, type, enumeration and row INDEX come from libsmi over this repo's `mibs/`, not from Datadog's hand-written names.
2. **Instances.** A scalar written without `.0` gets `.0` when the MIB says scalar. That matches Datadog's agent, which retries with `.0`. A GET of one row (`hrProcessorLoad.196608`) stays exact, and its `metricKey` carries the row (`hrStorageUsed_6`). Three Datadog shapes can never answer on a real device, so they become walks and are flagged `shape-mismatch`:
   - a GET of a bare table column (`dell-force10`, `dell-os10`)
   - a GET whose instance has fewer arcs than the table's INDEX (`apc-ups` `uioSensorStatusTemperatureDegC.0`, index `{port, sensor}`)
   - a GET of `.0` on a table keyed by a string, which means an empty name (`citrix-netscaler` `svcTotalClients.0`, `aruba-wireless-controller` `haActiveAPs.0`)

   A device tag with no MIB object and no `.0` gets `.0`, as the agent's retry does. The exception is a tag whose sibling OID is read by row, which shows it is a table column; it is walked (`avaya-cajun-switch` `genCpuUtilizationEnableMonitoring`).
3. **`extends` is flattened** into each profile, with `extends: none`. Mixins are listed in `origin.extends` and per OID in `datadog.from`.
4. **One entry per (OID, walk).** Every Datadog use of that OID (metric, tag, metadata field, custom metric name such as `cpu.usage`) is merged into the entry's `datadog` block. `metricKey` is the MIB object name, matching what the platform's repo sync uses.
5. **Types.** Types come from the MIB. When the MIB cannot type an object, the converter uses the type Datadog's recording sends for it (`type-from-recording`). Datadog's agent types values from the wire too. If the recording lacks the object, it falls back on Datadog usage (`type-from-datadog`):
   1. forced `metric_type`
   2. a numeric value `mapping`, which means `integer`
   3. role: metric means `gauge`, anything else `string`

   All 179 types this changed were checked against the real vendor MIBs, downloaded for the purpose. 175 were right; 3 are Integer where the MIB says Gauge32 (`3com-huawei` CPU and memory), and 1 has no public MIB.
6. **Cadence.** An OID is `every-poll` if it is a metric, a table tag column, a mapped tag, or a numeric non-metadata value. Tag columns label live rows, such as alarm descriptions or SMART status, and Datadog re-reads them every run. Inventory metadata and device-level string tags are `discovery`.
7. **Other fields.** `coalesceKey` is the row's INDEX objects, following AUGMENTS. `enumMap` comes from the MIB, else from Datadog's numeric mapping. The exception is an enumeration the MIB text declares as bit masks (Dell's "These values are bit masks"): combined readings like 5 would be unmapped, so the entry gets no `enumMap` and a `bitmask` loss. `scale_factor` 0.1 and 0.01 become `divideBy10` and `divideBy100`.
8. **Dropped.** Tag columns the MIB marks not-accessible (or accessible-for-notify) are dropped with a reason. On a conforming agent they never answer; Datadog was tagging with the row index. All 49 distinct dropped objects were checked against MIB text: each is an INDEX of the table it tags.
9. **Losses.** Anything the format cannot express is listed per profile, never silently dropped:
   - index tags
   - cross-table tag joins and `index_transform`. A tag column counts as cross-table when it lies outside the metric table's subtree and its INDEX differs; `ifXTable` on `ifTable` joins through `coalesceKey`, so it isn't a loss.
   - `extract_value`, `match_pattern`, `format`
   - `flag_stream` bit positions
   - `constant_value_one` metrics
   - static metadata values
   - tag regexes
10. **Categories and vendors** are classified by hand per Datadog profile in `categories.ts`. The registry's per-enterprise category is wrong for, say, a Cisco ASA. A new upstream profile without a row stops the converter.

## How accuracy is measured

| Check | What it proves |
|---|---|
| A. Accounting | Every Datadog OID reference lands in exactly one output entry or is dropped with a reason. Must be 0 failures. |
| B. Replay | Datadog keeps an snmpsim recording per profile (`snmp/tests/compose/data/*.snmprec`). For every reference Datadog's agent would get an answer for, the converted entry must get one too. |
| C. Wire types | Declared `type` against the SNMP type in the recording. |
| D. Identity | The recording's sysObjectID selects the same profile under Datadog's matching rules and ours. |
| E. Schema | Output against `schema/profile.schema.json`, unique `metricKey`, unique slugs. |

Recordings are synthetic. Replay proves the fetch shape (GET vs walk, instance suffix, OID typos), not that a real device answers. Where a recording disagrees with the MIB, either can be wrong: real-device captures (see "Testing") show Check Point sending `multiDisk*` sizes as strings and Juniper sending `hrProcessorFrwID` as an integer, as Datadog's recordings do, against their MIBs.

### Results at integrations-core `47ac6e1950cd`

| Check | Result |
|---|---|
| Profiles converted | 162 (12,529 OID entries from 16,036 references) |
| A. Accounting failures | 0 |
| E. Schema failures | 0 |
| B. References Datadog answers in its recordings | 5,869 across 150 recordings |
| B. Converted entry also answers | 5,784 (98.6%); **0 lost** |
| B. Dropped references that answer | 85, all not-accessible INDEX columns (the synthetic recordings include them) |
| C. Type mismatches | 39 of 4,972 answering entries, all MIB-typed, each checked against MIB source: `hrProcessorFrwID` ×18, Check Point `*64` ×9, iDRAC `drs*Reading`, and others. Another 427 types come from the recordings, so C can't check them; see rule 5. |
| D. Identity agrees | 149 / 150 (see "Known semantic differences") |

Conversion notes:
- 420 references do not resolve to a MIB object, almost all because 21 MIB modules are missing from `mibs/` (A10-AX-MIB, NASUNI-FILER-MIB, NETBOTZV2-MIB, ZEBRA-MIB and others; the report lists them all).
- 1,661 metrics are renamed by Datadog (for example `cpu.usage`).
- 85 GETs target a specific table row; all were checked for a plausible INDEX arity and value. 9 Datadog GETs that could never answer became walks.
- 37 profiles need OR matching.

## Known semantic differences

- **Wildcard stem.** Datadog's `X.*` matches only OIDs strictly under X. Our octet-anchored prefix `X` also matches X itself. This causes the one identity disagreement: a recording whose sysObjectID is exactly `1.3.6.1.4.1.12356.103.1`. Real devices rarely report a wildcard stem.
- **Exact sysObjectIDs.** A Datadog exact ID (`1.3.6.1.4.1.9.1.1745`) becomes a prefix, so it also matches deeper IDs.

## Spot check

Beyond the automated checks, 11 profiles were read entry by entry against the MIB source text and the Datadog files: `apc-ups`, `tripplite-ups`, `cisco-catalyst`, `cisco-asa`, `idrac`, `hp-ilo4`, `synology-disk-station`, `palo-alto`, `kyocera-printer`, `ubiquiti-unifi` and `zebra-printer`. OID numbers, `.0`, walk, types, `enumMap`, `coalesceKey` (including AUGMENTS) and match lists were all correct. The Catalyst and ASA `matchAny` sets equal Datadog's 447 and 125 IDs. The review found these converter defects, all fixed before import:

| Defect | Fix |
|---|---|
| A GET of `.0` on a two-part-index column (`apc-ups`) | Instance shorter than INDEX becomes a walk |
| Alarm description and SMART status tags polled at discovery | Tag columns are `every-poll` |
| Cross-table tags without Datadog's `table:` key not reported; `ifXTable` joins reported although they work | Detect by subtree and INDEX |
| Row GETs keyed `hrStorageUsed`, `hrStorageUsed_6_6` | Key by row: `hrStorageUsed_1`, `_6` |
| Dell bit-mask status readings given an exact `enumMap` | Drop `enumMap`, report `bitmask` |
| Unquoted `on`/`off` labels and regex strings, which PyYAML misreads | Quote them; every file parses under PyYAML |

Inherited from Datadog and left as is:
- **Unscaled values.** Readings in tenths are not transformed: APC `upsHighPrec*`, UPS-MIB voltages and frequencies, Dell probe readings.
- **Bytes as counters.** Synology `raidFreeSize`/`raidTotalSize` are sizes that the MIB declares Counter64.
- **Wrong names.** Synology `laLoadInt.1` is named `cpu.usage`.
- **Match scope.** Ubiquiti's exact `1.3.6.1.4.1.41112` becomes a prefix covering every Ubiquiti device.

## Before enabling

1. **OR matching.** 37 of 162 profiles list several sysObjectIDs (cisco-catalyst has 447), but `matchPatterns` are ANDed. The converter emits a *proposed* `matchAny` key with an empty `matchPatterns`. Without a format and platform change, the alternative is one file per sysObjectID. Unknown keys are ignored today, and the platform skips profiles with no patterns, so these 37 profiles match nothing. They are inert, not harmful: all have a vendor, so the category fallback, which only takes vendor-less profiles, never selects them.
2. **Flatten vs. `extends`.** The data-contract rule prefers referencing platform generic parents over duplicating their OIDs. The converter flattens instead, because Datadog's mixins (`_generic-if`, `_generic-tcp`, …) poll a different OID set than Kaleidoscope's curated parents, and repo sync does not persist `extends` yet. Option: drop mixins that a parent already covers and set `extends` to the category parent.
3. **Scope.** Datadog's `generic-ups` (converted as `generic-ups-datadog`) and `generic-device` overlap the monorepo's curated set. Decide whether to skip them.
4. **Missing MIBs.** 18 of the 21 missing modules resolve 354 of the 420 unresolved references. Another 50 are metadata fields for the same vendors. 10 more collide on the name `CONFIG-MIB`: Datadog means Avaya's, and this repo has HP's. Six objects are newer than the copies in `mibs/` (FortiGate, AsyncOS, MIB-Dell-10892, IB-DNSONE). Public copies exist for most modules, but many carry "all rights reserved" or confidential headers (A10, Ruckus, Avaya G700). Check their terms before adding them. CHRYSALIS-UTSP, INTERCEPTOR, NTCT-PFS-HEALTH, READYNASOS and ZEBRA-MIB have no public file. Also add registry rows for the 22 enterprise roots Datadog covers and we don't.
5. **Enablement.** Repo sync writes `enabled: true` whatever the file says (see below). A tenant that syncs this repository would start matching the 125 single-pattern profiles against real devices. Fix sync before tenants sync revision 2.

## Testing

| Level | What it proves | How |
|---|---|---|
| 1. Static | Schema, unique keys, conversion rules | `pnpm validate`, `pnpm test` |
| 2. Synthetic replay | Fetch shape and identity match Datadog | `pnpm import:datadog` report, checks A–E |
| 3. Real-device captures | OIDs answer and types match on real hardware | Replay against LibreNMS's `tests/snmpsim` |
| 4. Protocol | The platform poller, sync and matcher handle the profile | Serve captures with snmpsim in Docker; point a dev tenant at them |
| 5. Hardware | A real model and firmware answer | Walk a device, record the `tested` block, then set `enabled: true` |

Level 3 has been run once as a scratch experiment:
- **Data:** LibreNMS's 2,006 captures, from real devices with sanitized values (commit `5b81b47`).
- **Coverage:** 1,854 of the 1,876 captures with a sysObjectID match a converted profile. That exercises 115 of the 162 profiles.
- **Type disagreements found**, beyond the known `hrProcessorFrwID`:
  - F5 sends `ltm*CurConns` as Counter64, though the MIB says Gauge.
  - Check Point sends `fw*` counts as counters and `multiDisk*` sizes as strings.
  - A Sophos SG230 sends `sfosLiveUsersCount` as a string.
  - A Cisco WLC sends `bsnDot11EssNumberOfMobileStations` as a string.
- **Limits:** a capture holds only the OIDs LibreNMS polls, so an OID that doesn't answer isn't proof it fails. The data is GPL-3.0; fetch it in CI, never commit it.

## Platform gaps found while mapping the format

These live in the Kaleidoscope monorepo and affect any profile in this repo, not only converted ones. Read from the monorepo source at commit `e89659d7`:

- Repo sync writes `enabled: true` regardless of the file. It also ignores `transform`, `enumMap`, `cadenceTier`, `coalesceKey` and `metricsTemplate`, and does not persist `extends`.
- sysObjectID matching is a plain string `startsWith`, not octet-anchored as `docs/FORMAT.md` specifies. With the imported set this misroutes real devices. Catalyst's `1.3.6.1.4.1.9.1.230` would catch ASA `…9.1.2300`–`2306`, and `…9.1.150` would catch ASR `…9.1.1500`. That affects 66 IDs across ASA, ASR, ISR, cisco-sb and firepower-asa.
- The generic poller applies transforms, and the extractor applies them again. `coalesceKey` is not read anywhere. `counter` gets no rate computation outside the IF-MIB worker.

## Other findings

- libsmi emits no SYNTAX for a type an SMIv2 module uses without importing it, such as `Gauge` in `mibs/aruba/WLSX-HA-MIB`. The converter treats such objects as untyped. The dictionary compiler still types them `string`, as in `dictionaries/aruba` `haActiveAPs`.
- The module-name scan must tolerate comment lines between the module name and `DEFINITIONS` (`mibs/rfc/FCMGMT-MIB`, `mibs/ubiquiti/FROGFOOT-RESOURCES-MIB`).
