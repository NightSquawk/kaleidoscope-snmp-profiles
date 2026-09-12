# kaleidoscope-snmp-profiles

Public SNMP profile data for [Kaleidoscope](https://kaleidoscope.sh): vendor OID dictionaries, community device profiles, a sysObjectID identity registry, and the raw MIB sources they are compiled from.

**Status:** published 2026-09-11. Dictionaries for 127 vendor/category pairs (529,016 OIDs) are compiled and validated. Format version 1 is a proposal until the Kaleidoscope importer ships support for it.

## Why this repo exists

Kaleidoscope polls network gear over SNMP using *profiles*: a list of OIDs worth fetching for one kind of device plus rules for recognizing that device. The platform ships a small curated set of profiles inside its own monorepo. Everything that is large, generated, or community-maintained lives here instead:

| Content | Where | Why here |
|---|---|---|
| Vendor OID dictionaries (tens of thousands of OIDs, generated) | `dictionaries/` | Reference data for the profile editor. Too big to seed into every tenant. |
| Community vendor profiles | `profiles/` | Adding a vendor should be a pull request here, not a platform change. |
| sysObjectID identity registry | `registry/` | Vendor and category knowledge for one enterprise OID prefix, shared by the compiler and the platform's auto-match. |
| Raw MIB files | `mibs/` | Source material for the compiler. Never shipped to a tenant. |

Kaleidoscope pulls this repo through its existing MIB profile repo import. Each tenant can register it, review what was parsed, and accept it. Nothing here is required for a Kaleidoscope install to work.

## Layout

```
manifest.yaml            format version, namespace, category → default parent map
registry/sysobjectid.yaml  enterprise OID prefix → vendor, category, default parent, action
profiles/<category>/<vendor>/*.yaml   community profiles, hand-authored (format: docs/FORMAT.md)
dictionaries/<vendor>/*.json          generated OID dictionaries, one per vendor+category
mibs/<vendor>/                        raw MIB sources, plain git (text)
examples/                             templates and worked examples (not imported)
schema/                               JSON Schema for every file type above
tools/                                validate + compile scripts (Node 22+, pnpm; compile needs libsmi or Docker)
docs/FORMAT.md                        the profile file format
```

Directories named `examples`, `docs`, `tests`, `fixtures`, `scripts`, and `dist` are skipped by the Kaleidoscope importer. Put anything that should not become a profile in one of those.

## Quick start

```bash
cd tools
pnpm install
pnpm validate            # schema + cross-file checks over the whole repo
pnpm compile             # rebuild dictionaries/ from mibs/ using registry/sysobjectid.yaml
pnpm compile --mibs /path/to/mib/collection   # compile from a directory outside the repo
```

`pnpm validate` runs in CI on every pull request, and CI also compiles a fixture MIB to prove the toolchain works. When a push to `main` touches `mibs/`, `registry/`, or the compiler, the `recompile` workflow rebuilds `dictionaries/` on a GitHub runner and commits the result, so contributors do not need libsmi locally.

### The compiler needs libsmi

Dictionaries are compiled with [libsmi](https://www.ibr.cs.tu-bs.de/projects/libsmi/)'s `smidump`, the reference SMI parser. Install it natively (`apt install smitools`, `brew install libsmi`, `dnf install libsmi`) or do nothing and, if Docker is available, the compiler runs `tools/bin/smidump-docker`, which builds a small Debian image on first use. Set `SMIDUMP=/path/to/smidump` to force a specific binary.

`pnpm compile` writes `dictionaries/COMPILE-REPORT.md` alongside the JSON: what was parsed, what was dropped and why, which enterprises have MIBs but no registry row, and which files crashed libsmi.

## How Kaleidoscope consumes this

1. A tenant admin registers `https://github.com/NightSquawk/kaleidoscope-snmp-profiles` under **Settings → MIB Profile Repos**.
2. The sync worker clones the default branch, walks `profiles/**/*.yaml`, and stages one profile per file under the namespace `nightsquawk/kaleidoscope-snmp-profiles`.
3. The admin reviews the parsed result and accepts the repo.

Compatibility with the importer as of 2026-09-11:

- Only `*.yaml` / `*.yml` files are scanned. `dictionaries/**/*.json` is inert until the importer learns JSON and the `role: dictionary` key. That is intentional: dictionaries must never be auto-assigned to devices.
- `extends` is parsed but not yet persisted. Until that lands, a vendor profile that relies on a generic parent for standard MIB data will import without it.
- Imported slugs are prefixed with the namespace and stored in a 100-character column. Keep `slug` at 60 characters or fewer.
- Unknown keys are ignored, so `formatVersion`, `pollIntervalSeconds`, and per-OID `cadenceTier` are safe to author now and take effect when the platform supports them.

The platform-side work that closes those gaps is tracked in the Kaleidoscope monorepo design doc for the SNMP profile system.

## Relationship to the Kaleidoscope monorepo

- The ~26 curated profiles (`generic-printer`, `apc-ups`, `hp-jetdirect-printer`, …) stay in the monorepo and seed every tenant offline. They are **not** duplicated here. Profiles in this repo may `extends` them by slug.
- `dictionaries/` is generated here with libsmi. The monorepo's `compiled-mibs.json` was not reused: its compiler mis-grouped about three quarters of its 55,919 OIDs under the wrong vendor (see `dictionaries/README.md`). The monorepo copy is scheduled for removal.
- The monorepo still carries its own regex MIB parser (`packages/core/src/lib/mib-parser.ts`) for the single-file upload route in Settings. That parser is not used here and is known to miss most objects; replacing it is tracked in the monorepo design doc.

## Known limitations (2026-09-11)

- **libsmi 0.4.8 misbehaves on a few files.** It segfaults on some malformed MIBs, and its XML writer loops forever on at least one valid-looking one (ALCATEL-ENT1-TIMETRA-PORT-MIB). The compiler runs it in chunks with a deadline and an output cap, isolates offenders by bisection, and lists them in `dictionaries/COMPILE-REPORT.md`; everything else in the same directory still compiles.
- **Type resolution depends on the textual-convention modules being reachable.** Standard ones come from `mibs/rfc/` or the system MIB directory; vendor ones from the vendor directory. Objects whose TC cannot be found are typed `string` and counted in the report.
- **Only registered vendors have sources in `mibs/`.** 134 directories, about 560 MB of text (much less packed). The compile report lists the enterprise roots present in `mibs/` that still have no registry row; a larger local mirror holds roughly 380 more, mostly carrier, optical, and industrial gear left out on purpose. Each needs a registry row and its MIB directory imported before it compiles.
- **`dictionaries/` is 240 MB of JSON.** Cisco is 45 MB and Huawei about 30 MB. Git packs JSON well, but consumers should clone shallow.

## Contributing

See `CONTRIBUTING.md`. In short: one vendor per pull request, one profile per file, `pnpm validate` clean, and a note on which real device you tested against.

## License

Apache License 2.0 for everything authored here: profiles, registry, dictionaries, schemas, and tools. See `LICENSE`. Raw MIB files under `mibs/` are vendor publications redistributed as-is and remain under their respective vendors' terms; if you are a vendor and want a file removed, open an issue.
