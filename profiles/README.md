# profiles/

Community vendor profiles. One file per profile, path `profiles/<category>/<vendor>/<slug>.yaml`.

The curated set that seeds every Kaleidoscope tenant lives in the platform monorepo. Profiles here add vendor-specific OIDs.

As of 2026-09-13 every profile here is converted from Datadog's integrations-core SNMP profiles. Each file has an `origin` block; the license is in `../NOTICE`. All are `enabled: false` and untested on Kaleidoscope. How they were converted and checked, and what they cannot express yet, is in `../docs/DATADOG-IMPORT.md`. Regenerate them with that procedure; don't hand-edit a converted file without removing its `origin` block.

Start a new profile from `../examples/_template.yaml`. Format reference: `../docs/FORMAT.md`. Rules: `../CONTRIBUTING.md`.
