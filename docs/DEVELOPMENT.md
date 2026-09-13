# Development workflow

This project separates four concerns: raw MIB sources, registry knowledge, generated OID reference data, and small community profiles worth polling. The goal is to expand device coverage through public contributions without enlarging the platform's mandatory tenant seed data. A successful change preserves those boundaries and supplies evidence appropriate to the data or tooling it changes.

## Before changing files

Read [the project overview](../README.md), [contribution requirements](../CONTRIBUTING.md), [the format](FORMAT.md), and [agent guidance](../AGENTS.md). Inspect the branch and working tree. Locate the relevant schema, registry row, vendor source, and tool implementation before editing generated output or assuming a platform behavior exists.

Use a focused contributor branch and PR against `main`. The existing `recompile` workflow publishes generated dictionaries on `main`; the platform's release-branch model does not apply here.

## Checks by change

All package commands below run from `tools/`. CI uses Node 22 and pnpm 9.

```bash
pnpm install --frozen-lockfile
pnpm check-types
pnpm validate
```

| Change | Additional review/evidence |
|---|---|
| Community profile | One file per slug; valid parent and match patterns; metric keys, scalar/table semantics, cadence; model/firmware/responding OIDs, or `enabled: false` |
| Registry or raw MIBs | Prefix ownership, category, compile grouping, public source/terms; a focused compile preview when libsmi is available, or clearly defer compilation to CI |
| Compiler or parser | Fixture smoke check below, regression evidence for the affected behavior, relevant real-MIB comparison, and skipped/unresolved-object diagnostics |
| Format/schema | Update validator/compiler/types/docs/examples as affected; assess importer compatibility and format version deliberately |
| Published profiles/dictionaries | Assess whether `manifest.yaml` revision must increase to request tenant re-sync; inspect semantic output differences |
| Rules/documentation | Existing commands/paths resolve, examples remain accurate, mirrors match, `git diff --check` passes |

`pnpm validate` checks schemas and cross-file invariants. It does not contact devices or exercise the platform importer. Missing `tested` metadata on enabled profiles is currently a warning, although contribution policy requires disabling untested profiles. Existing dictionary duplicate-key warnings can be expected because module names repeat; investigate changes in warning counts rather than suppressing them.

## Safe compiler smoke check

Run this Bash example from `tools/`. It reproduces the existing CI fixture assertion without replacing tracked dictionaries. The new temporary directory is dedicated to this run.

```bash
KSP_SMOKE_DIR=$(mktemp -d)
pnpm compile --mibs fixtures/mibs --out "$KSP_SMOKE_DIR/dict" --report "$KSP_SMOKE_DIR/COMPILE-REPORT.md"
node --input-type=module - "$KSP_SMOKE_DIR/dict/cisco/mib-cisco-switch.json" <<'JS'
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const dictionary = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert.equal(dictionary.oids.length, 5);
const types = Object.fromEntries(dictionary.oids.map(oid => [oid.name, oid.type]));
for (const [name, type] of Object.entries({
  kspName: 'string', kspLoad: 'gauge', kspState: 'integer',
  kspEnabled: 'integer', kspPortInOctets: 'counter',
})) assert.equal(types[name], type, name);
console.log('fixture ok', types);
JS
```

If a `smidump` wrapper on your PATH reports a version but cannot locate the fixture's absolute path, inspect its mount configuration. To select this repository's Docker wrapper explicitly, run `export SMIDUMP="$PWD/bin/smidump-docker"` from `tools/` before the smoke check. The repository wrapper mounts the compiler's source and import paths; a wrapper hardcoded for another checkout may not. A report labeling a file as crashed can also reflect a missing container mount: read the underlying diagnostics before blaming the MIB.

For a vendor preview, use another new temporary directory and `pnpm compile --vendor <source-directory-slug> --out <temporary-output> --report <temporary-report>`. Inspect emitted OIDs and report diagnostics. The filter selects source groups; their names need not equal emitted vendor labels. Vendor-only compilation does not delete stale output directories and produces a partial report.

A full `pnpm compile` deletes output subdirectories before rebuilding them. Only use the default tracked output for intentional regeneration. Keep the timeout, output-limit, and bisection protections in `tools/src/smidump.ts`: a successful process exit does not imply that every input MIB compiled. Generated dates and wall time are expected sources of churn.

## Debugging and completion

Trace a missing or incorrect OID through its registry prefix, source MIB/import dependencies, libsmi diagnostics, textual-convention resolution, compiler output, and validator. Reduce failures to a vendor or fixture before running the entire corpus. Use the compile report to distinguish absent registration, non-readable objects, unresolved types, and parser failures. Investigate platform import behavior separately.

The PR should state what changed and why, affected vendors/categories, source or device evidence, commands and outcomes, new versus existing warnings, and remaining importer/re-sync implications. Do not call a profile tested merely because validation passed. Review the final diff for unrelated work and generated churn. Preserve other contributors' index and worktree changes; use explicit paths for both staging and committing.

## Adaptation record

Reviewed on 2026-09-13 against the local `NightSquawk/Kaleidoscope` checkout at HEAD `e89659d7246d93e63d736a392c124a655c64e925`. Source material includes its `AGENTS.md`, `CLAUDE.md`, `.claude/rules/`, mirrored `.codex/rules/` and `.cursor/rules/` layout, activity-hook documentation and configuration layout, and related change-control, validation, debugging, and writing skill documents. Those platform documents are reference material; the rules committed here govern this project's workflow.

| Upstream guidance | Adaptation here |
|---|---|
| Core instructions and agent rule briefing | Focused edits, read existing patterns, communicate applicable constraints when delegating; SNMP data/tool boundaries replace service/RLS/UI constraints |
| Git commit workflow and stash/build gate | Preserve work, explicit staging and commit paths, Conventional Commits, validation before committing; use `main` PRs and existing tool checks instead of release branches and `pnpm build` |
| Socket/connection management | Apply bounded resource use and cleanup to libsmi child processes, deadlines, output caps, and batch isolation |
| Data-interface definition of done | Review OID semantics, cadence, device evidence, and consumer compatibility; platform database write targets and queue registrations remain platform responsibilities |
| Changelog generation and writing guidance | Describe concrete consumer effects in PRs and relevant existing docs; no copied dashboard changelog, version branches, or invented release history |
| Context7/research guidance | Prefer source and version-appropriate primary library documentation; Context7 is optional when available, with no copied MCP configuration |
| Validation and debugging processes | Type/schema checks, temporary fixture generation, focused reproductions, compile-report review, and explicit evidence/limitations |
| Audit/privacy guidance | Preserve provenance and vendor terms; exclude credentials and private/customer device data from public artifacts |
| Activity logging and session hooks | Do not infer Curacao funding for this repository. Existing user/global logging policy can apply externally; no client billing metadata, private paths, or global-hook installers are copied |
| Routes, services, frontend, RLS/migrations, permissions, auth/session security, feature flags, shadcn, form/RUM rules | Omitted: this repository has no application routes, database, UI, tenant runtime, or deployment stack |
| Platform skills, discovery archives, MCP configs, and host-specific settings | Consulted where relevant; not copied as executable setup or skills because their package paths, services, and environments belong to the platform |

The upstream `AGENTS.md` and `CLAUDE.md` identify three rule surfaces. This repository follows that documented layout: identical `.mdc` rules under `.claude/rules/`, `.codex/rules/`, and `.cursor/rules/`, with identical root entry documents explicitly directing agents to read them. Platform-specific Gemini/Antigravity mirrors and hook installers are not required for this initial adaptation.

Keep all three rule directories identical when editing. From the repository root:

```bash
cmp AGENTS.md CLAUDE.md
diff -qr .claude/rules .codex/rules
diff -qr .claude/rules .cursor/rules
git diff --check
```

Update this record when importing new upstream processes. Verify that commands, paths, and contract claims still fit this repository before carrying them over.
