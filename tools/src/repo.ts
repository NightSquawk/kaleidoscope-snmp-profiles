/**
 * Shared helpers: locate the repo root, load the manifest and registry,
 * walk directories for profile / dictionary files.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface Manifest {
  formatVersion: number;
  namespace: string;
  revision: number;
  defaultParents: Record<string, string>;
  externalParents: string[];
  paths: { profiles: string; dictionaries: string; registry: string; mibs: string };
}

export interface RegistryEntry {
  oidPrefix: string;
  vendor: string;
  deviceCategory: string;
  defaultParent?: string | null;
  action?: 'assign' | 'downgrade' | 'ignore';
  profileSlug?: string | null;
  compile?: boolean;
  note?: string;
}

export interface Registry {
  formatVersion: number;
  entries: RegistryEntry[];
}

export async function loadYaml<T>(path: string): Promise<T> {
  return parseYaml(await readFile(path, 'utf8')) as T;
}

export async function loadJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

export async function loadManifest(): Promise<Manifest> {
  return loadYaml<Manifest>(join(REPO_ROOT, 'manifest.yaml'));
}

export async function loadRegistry(manifest: Manifest): Promise<Registry> {
  return loadYaml<Registry>(join(REPO_ROOT, manifest.paths.registry));
}

/** Recursively list files under `dir` whose extension is in `exts` (lowercase, with dot). */
export async function walkFiles(dir: string, exts: string[]): Promise<string[]> {
  const out: string[] = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    const s = await stat(full);
    if (s.isDirectory()) out.push(...await walkFiles(full, exts));
    else if (exts.includes(extname(name).toLowerCase())) out.push(full);
  }
  return out;
}

/** True when `oid` equals `prefix` or starts with `prefix.` (octet-anchored). */
export function oidHasPrefix(oid: string, prefix: string): boolean {
  return oid === prefix || oid.startsWith(prefix + '.');
}

export function slugifyVendor(vendor: string): string {
  return vendor.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
