# dictionaries/

Generated. Do not edit by hand.

One JSON file per vendor and category, `dictionaries/<vendor>/<slug>.json`, containing every readable OBJECT-TYPE the vendor's MIBs define under their enterprise prefix. `role: dictionary`, no `matchPatterns`. Kaleidoscope imports these disabled and uses them as the OID reference behind the profile editor and import wizard. They are never assigned to a device.

Regenerated automatically by the `recompile` GitHub workflow on every push to `main` that touches `mibs/`, `registry/`, or `tools/`. To regenerate locally:

```bash
cd tools && pnpm compile                      # from mibs/
cd tools && pnpm compile --mibs /path/to/mibs # from a MIB collection outside the repo
```

The compiler drives libsmi's `smidump` (native or through Docker, see the top-level README), one process per vendor directory, and groups objects by the compile-enabled prefix rows in `registry/sysobjectid.yaml`. Matching is octet-anchored and the shortest matching row wins, so a vendor's whole tree lands in one dictionary even when deeper rows exist for sysObjectID identity. Objects outside the row's prefix, objects that cannot be read (`not-accessible`, `accessible-for-notify`), and objects under enterprises with no registry row are dropped and counted.

Each OID entry carries `oid`, `name`, `metricKey`, `type` (`integer|string|gauge|counter|timeticks|oid`, resolved through textual conventions), `walk` (true for table columns; scalars carry the `.0` instance suffix so they can be polled as-is), `description` (first 200 characters), `enumMap` for enumerations, and when present `units`, `status` (only if not `current`), `module`, and `tc` (the textual convention the object was declared with).

`COMPILE-REPORT.md` in this directory is written on every run: counts, per-dictionary sources, enterprises with MIBs but no registry row, files libsmi crashed on, hung on, or produced runaway output for (each is isolated by bisection and skipped), and textual conventions that could not be resolved.

## History

- 2026-09-11: first generation with a copy of the monorepo's regex parser (17 files, 13,775 OIDs). That parser turned out to extract about 18% of the objects in its input.
- 2026-09-11, later: regenerated with libsmi 0.4.8. A first pass over a 14,391-file local mirror produced 20 dictionaries / 142,922 OIDs and showed that 1,102,053 further readable objects sit under 486 enterprises with no registry row, so coverage grows by adding rows and importing those vendors' directories. The 23 directories those 20 dictionaries came from were then committed under `mibs/` and the dictionaries regenerated from the repo alone: 20 dictionaries, 143,196 OIDs (Cisco 89,048; HP 29,245; Juniper 9,553), 44 s on 4 cores, 1 file skipped (`juniper/EX2500-BASE-MIB` crashes libsmi), 156 objects typed `string` for lack of a textual convention. The Cisco file is 45 MB (dropping descriptions would only get the total from 68 MB to 52 MB); GitHub's hard limit is 100 MB per file, so if Cisco keeps growing the dictionary will need splitting by module family.

The monorepo's older `compiled-mibs.json` (55,919 OIDs) was never carried over. Its compiler matched enterprise prefixes as plain string prefixes, so `1.3.6.1.4.1.23` (Novell) swallowed `1.3.6.1.4.1.2356` (Lancom) and `1.3.6.1.4.1.2` (IBM) landed in Sophos. Roughly 75% of its OIDs were under the wrong vendor.
