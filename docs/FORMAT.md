# Profile file format, version 1

One YAML file per profile. The file name is the slug. Unknown keys are ignored by the importer, so newer keys are safe to author before the platform supports them.

## Top level

| Key | Type | Required | Notes |
|---|---|---|---|
| `formatVersion` | integer | yes | Always `1` for this spec. |
| `slug` | string | yes | `^[a-z0-9][a-z0-9-]*$`, 60 chars or fewer. Unique across the repo. |
| `name` | string | yes | Display name. |
| `description` | string | no | Free text. |
| `role` | `profile` \| `dictionary` | no | Default `profile`. Dictionaries are reference-only: never matched, never assigned, imported disabled. |
| `deviceCategory` | enum | yes | `ups`, `switch`, `access_point`, `server`, `printer`, `firewall`, `nas`, `generic`. |
| `vendor` | string \| null | no | Manufacturer. `null` means generic. |
| `extends` | string \| `none` | no | Parent profile slug. Omitted means "apply the category default from `manifest.yaml`". `none` means no parent. |
| `includes` | string[] | no | Slugs composed into this profile. Owner's OIDs win, then includes in order. |
| `priority` | integer | no | Ordering hint for the platform's list view. Vendor profiles 5, generics 100. Default 5. |
| `enabled` | boolean | no | Default `true`. Untested profiles must set `false`. |
| `pollIntervalSeconds` | integer | no | Default poll cadence for devices assigned this profile. Platform default 60. Suggested: printers 900, UPS 300, switches 60. |
| `discoveryIntervalSeconds` | integer | no | How often `discovery`-tier OIDs are re-fetched. Platform default 3600. |
| `matchPatterns` | array | profiles: yes, dictionaries: forbidden | See below. |
| `metricsTemplate` | object | no | Maps `metricKey`s onto the platform's dashboard template for the category. Shape is owned by the platform; leave `{}` if unsure. |
| `oids` | array | yes | See below. At least one entry. |
| `tested` | object | no | `{ device: string, firmware: string, date: YYYY-MM-DD, by: string }`. Strongly encouraged. |

Dictionary files additionally carry `vendorOidPrefix` (string) and `generated` (`{ source, date, oidCount, compiler, modules }`) and are JSON rather than YAML. Their `oids[]` entries may also carry compiler-derived keys that profiles do not use: `units`, `status` (only when not `current`), `module` (defining MIB module) and `tc` (the textual convention the object was declared with). Consumers must ignore unknown keys.

## `matchPatterns[]`

All patterns in the list must match for the profile to be a candidate (AND).

| Key | Values |
|---|---|
| `field` | `sysObjectId` (octet-anchored prefix), `sysDescr` (case-insensitive substring), `deviceCategory` (exact) |
| `pattern` | string. For `sysObjectId`: dotted OID, no leading dot. |

Specificity is the number of octets in the longest `sysObjectId` pattern. More specific wins.

## `oids[]`

| Key | Type | Required | Notes |
|---|---|---|---|
| `oid` | string | yes | Dotted numeric OID. For scalars include the trailing `.0`. |
| `name` | string | yes | MIB object name, e.g. `prtMarkerSuppliesLevel`. |
| `metricKey` | string | yes | Key the value is stored under. Unique within the profile. Child profiles override parent entries with the same `metricKey`. |
| `type` | enum | yes | `integer`, `string`, `gauge`, `counter`, `timeticks`, `oid`. |
| `walk` | boolean | yes | `true` for tables (GETBULK walk), `false` for scalars (GET). |
| `description` | string | no | |
| `cadenceTier` | enum | no | `every-poll`, `discovery`, `fallback-only`. If omitted the platform infers: counters, gauges, integers, timeticks are `every-poll`; strings and OIDs are `discovery`. **Set it explicitly on any string-typed OID that carries live state**, such as an error-state bitmap. |
| `cadenceOverride` | enum | no | Same values. Operator override slot; leave unset in this repo. |
| `coalesceKey` | string[] | no | Index columns for walked tables, e.g. `[prtMarkerSuppliesIndex]`. Empty for scalars. |
| `friendlyName` | string | no | Label for the UI. Defaults to `name`. |
| `transform` | string \| null | no | Platform transform id, e.g. `percent`, `centiCelsius`. Leave null if unsure. |
| `enumMap` | object | no | Integer value → label, e.g. `{ "1": "other", "3": "idle" }`. |

## Minimal example

```yaml
formatVersion: 1
slug: acme-printer
name: ACME Printer
deviceCategory: printer
vendor: ACME
extends: generic-printer
pollIntervalSeconds: 900
matchPatterns:
  - field: sysObjectId
    pattern: 1.3.6.1.4.1.99999
oids:
  - oid: 1.3.6.1.4.1.99999.1.2.0
    name: acmeWasteTonerLevel
    metricKey: wasteTonerPercent
    type: gauge
    walk: false
    cadenceTier: every-poll
    transform: percent
tested:
  device: ACME LaserWorks 4000
  firmware: 2.14
  date: 2026-09-11
  by: "@someone"
```

## Compatibility notes for the current importer (2026-09-11)

- `extends` is read but not stored yet. The category default in `manifest.yaml` will be applied once the platform ships that support.
- Only YAML is scanned; JSON dictionaries are inert.
- `pollIntervalSeconds`, `discoveryIntervalSeconds`, `role`, `tested`, and per-OID `cadenceTier` are stored only once the platform supports them. They are safe to author now.
