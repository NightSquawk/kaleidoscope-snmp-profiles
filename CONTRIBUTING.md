# Contributing

## Adding a vendor profile

1. Copy `examples/_template.yaml` to `profiles/<category>/<vendor>/<slug>.yaml`. Category is one of `ups`, `switch`, `access_point`, `server`, `printer`, `firewall`, `nas`, `generic`.
2. Fill in `slug`, `name`, `vendor`, `deviceCategory`, and `matchPatterns`. The `sysObjectId` pattern is the vendor's enterprise prefix or a more specific sub-tree. Matching is octet-anchored: `1.3.6.1.4.1.9` matches `1.3.6.1.4.1.9.1.1` and never `1.3.6.1.4.1.91`.
3. Set `extends` to the generic profile for the category, or `none` if the device has no standard MIB support. If you omit it, the platform applies the category default from `manifest.yaml`.
4. List only the OIDs that carry value. Dictionaries already hold every OID the vendor MIB defines. A profile is the curated subset that is worth polling.
5. Tag each OID with a `cadenceTier`:
   - `every-poll` for counters, gauges, and status values that change.
   - `discovery` for serials, model strings, MAC addresses, firmware, and supply metadata. Fetched hourly by default.
   - `fallback-only` for OIDs used only when a preferred OID is absent.
6. Set `pollIntervalSeconds` if the category default is wrong for this device class.
7. Run `pnpm validate` from `tools/`.
8. In the pull request, name the device model and firmware you tested against and paste the OIDs that answered. Untested profiles are accepted only with `enabled: false`.

## Adding to the identity registry

`registry/sysobjectid.yaml` holds one row per OID prefix: enterprise roots, plus a few IETF subtrees (Printer-MIB, UPS-MIB, HOST-RESOURCES-MIB) that exist only so the compiler emits dictionaries for them. Add a row when you know a prefix's vendor and category. Use `action: downgrade` with a `profileSlug` for devices that identify as one thing but answer as another (an external print server that claims to be a printer, for example).

## Adding raw MIBs

Place the vendor's MIB files under `mibs/<vendor>/` (any file name; many vendors ship them without an extension). Add the vendor's registry row in `registry/sysobjectid.yaml` first; MIBs under an enterprise with no row are parsed but not written. You can stop there: once the pull request merges, the `recompile` workflow regenerates `dictionaries/` and `COMPILE-REPORT.md` on a GitHub runner and commits them. If you have libsmi (`smidump`) or Docker locally, `pnpm compile --vendor <vendor>` shows you the result first; check the report for skipped files (libsmi crash, hang, or runaway output) or unresolved textual conventions. Keep vendor terms in mind: only redistribute MIBs the vendor publishes openly.

If the vendor's enterprise number has no row in `registry/sysobjectid.yaml`, the compiler lists it under "Enterprises with MIBs but no registry row" and writes nothing for it. Add the row first.

## Rules

- One vendor per pull request.
- One profile per file. The file name is the slug.
- Never edit `dictionaries/**/*.json` by hand. Regenerate.
- Never put a `matchPatterns` key on a dictionary. Dictionaries are reference data.
- `pnpm validate` must pass. CI enforces it.
