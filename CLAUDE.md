# kaleidoscope-snmp-profiles

Public SNMP reference data and community polling profiles for Kaleidoscope. This repository holds raw vendor MIBs, a sysObjectID identity registry, generated OID dictionaries, and hand-authored profiles. The platform consumes this optional data; runtime polling and tenant behavior live in the separate Kaleidoscope repository.

## Start here

Read `README.md`, `CONTRIBUTING.md`, and `docs/FORMAT.md` for purpose, submission rules, and the data contract. Read `docs/DEVELOPMENT.md` for validation, safe compiler previews, and the rationale for adapting upstream guidance.

## Layout

| Path | Responsibility |
|---|---|
| `manifest.yaml` | Format version, namespace, revision, paths, and external/default parents |
| `profiles/` | Curated community polling subsets, one YAML file per profile |
| `registry/sysobjectid.yaml` | OID prefix identity and compiler grouping |
| `mibs/` | Raw vendor sources and standard import modules |
| `dictionaries/` | Generated reference JSON and compile report; never edit by hand |
| `schema/` | JSON Schema contracts |
| `tools/src/` | TypeScript validator, compiler, shared helpers, and libsmi process wrapper |
| `tools/fixtures/` | Compiler smoke-test MIB |
| `.github/workflows/` | Validation and automatic dictionary regeneration |
| `examples/`, `docs/` | Non-imported examples and documentation |

## Rules

Read the following rule files before making changes. `.codex/rules/` is an explicitly referenced rule library; directory presence alone is not a substitute for reading it. For other agent surfaces, use the same files under `.claude/rules/` or `.cursor/rules/`.

| Rule | File under each rules directory |
|---|---|
| Core behavior and project boundaries | `core-instructions.mdc` |
| Branches and scoped commits | `git-commit-workflow.mdc` |
| Shared-worktree preservation | `stash-build-gate.mdc` |
| Profiles, registry, and compatibility | `snmp-data-contract.mdc` |
| Safe generation and parser lifecycle | `compiler-and-mibs.mdc` |
| Validation and debugging evidence | `validation-and-evidence.mdc` |
| Documentation, research, and change notes | `documentation-and-research.mdc` |

Keep `AGENTS.md` and `CLAUDE.md` identical, and all three rule directories identical in filenames and contents. User instructions take precedence over these repository defaults. Do not copy upstream rules wholesale; see the adaptation record in `docs/DEVELOPMENT.md`.

## Commands

Run from `tools/` with Node 22+ and pnpm 9:

```bash
pnpm install --frozen-lockfile
pnpm check-types
pnpm validate
```

For intentional full regeneration, `pnpm compile` writes tracked `dictionaries/` and removes its prior output subdirectories. Use the temporary-output procedure in `docs/DEVELOPMENT.md` for fixtures and previews. Compilation requires native libsmi `smidump` or Docker; `SMIDUMP` overrides the binary.

## Essential constraints

- Dictionaries are reference-only: `role: dictionary`, no match patterns, and intended to be imported disabled. The compiler does not currently emit an `enabled` key.
- Untested profiles must set `enabled: false`; do not invent device evidence.
- OID matching must respect numeric-component boundaries. Compiler grouping uses the shortest registered prefix; profile matching favors more specific prefixes.
- Coordinate schema, tool, documentation, and example changes. Local format support does not prove importer support.
- Preserve unrelated work. Never stash for routine validation; stage and commit only explicit owned paths when committing.
- Public data must not contain customer credentials or private device walks. Raw MIBs retain vendor terms.
