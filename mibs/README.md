# mibs/

Raw vendor MIB sources, one directory per vendor, any file name (`.mib`, `.my`, `.txt`, or no extension). Plain git, no LFS (they are text). Input to `tools/ pnpm compile`; never shipped to a Kaleidoscope tenant.

`mibs/rfc/` (also recognised: `ietf/`, `iana/`, `_base/`) holds the standard modules that vendor MIBs import: SNMPv2-SMI, SNMPv2-TC, IF-MIB, ENTITY-MIB and so on. It is put on libsmi's search path and never compiled into a dictionary. When it is absent the compiler falls back to the system MIB directory (`/usr/share/snmp/mibs`), which is enough for SNMPv2-SMI/TC but not for the larger IETF modules many vendor MIBs import.

Holds the 22 directories the registry compiles as of 2026-09-11 (about 209 MB, 3,200 files), imported from a larger local mirror of a public MIB collection. Add a vendor by adding its registry row first, then importing its directory:

```bash
# from the repo root; SOURCE is a directory laid out as <vendor>/<files>
tools/import-mibs.sh /path/to/source <vendor>
```

Pushing the change to `main` triggers the `recompile` workflow, which regenerates `dictionaries/` and commits it. Only redistribute MIBs the vendor publishes openly.
