import { mkdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import {
  BASE_HOME,
  GATEWAY_CONF_DIR,
  GATEWAY_ROOT,
  LEGACY_CONFIG_PATH,
  MANAGED_SITES_ROOT,
  REGISTRY_PATH,
} from "../paths.js";
import { migrateLegacyConfig, migrateRawRegistry } from "./schema.js";
import type { Registry } from "../types.js";
import { note } from "@clack/prompts";
import { atomicWriteText, ensureDir } from "../fsutils.js";

export async function ensureBaseDirs(): Promise<void> {
  await ensureDir(BASE_HOME);
  await ensureDir(MANAGED_SITES_ROOT);
  await ensureDir(GATEWAY_ROOT);
  await ensureDir(GATEWAY_CONF_DIR);
}

async function readRegistryFile(): Promise<{ raw: unknown }> {
  let content: string;
  try {
    content = await readFile(REGISTRY_PATH, "utf8");
  } catch {
    return { raw: null };
  }

  try {
    return { raw: JSON.parse(content) };
  } catch {
    // Corrupt file: preserve it for inspection and start fresh rather than crash.
    const backup = `${REGISTRY_PATH}.corrupt-${Date.now()}`;
    await rename(REGISTRY_PATH, backup).catch(() => {});
    note(`sites.json was unreadable and has been backed up to ${backup}.`, "Recovered");
    return { raw: null };
  }
}

let migrationNoticeShown = false;

export async function loadRegistry(): Promise<Registry> {
  await ensureBaseDirs();

  const { raw } = await readRegistryFile();
  const migration = await migrateRawRegistry(raw);
  let registry = migration.registry;
  let needsSave = migration.changed;

  if (Object.keys(registry.sites).length === 0) {
    try {
      const legacyContent = await readFile(LEGACY_CONFIG_PATH, "utf8");
      const legacy = JSON.parse(legacyContent) as unknown;
      const result = await migrateLegacyConfig(legacy, registry);
      registry = result.registry;
      if (result.migratedKey) {
        migration.notes.push(
          `Migrated legacy config '${result.migratedKey}' from ${path.basename(LEGACY_CONFIG_PATH)}.`,
        );
        needsSave = true;
      }
    } catch {
      // no legacy config — fine
    }
  }

  // Persist migrations unconditionally; only the user-facing notes are
  // shown once per process.
  if (needsSave) {
    for (const noteText of migration.notes) {
      if (!migrationNoticeShown) note(noteText, "Migration");
    }
    migrationNoticeShown = true;
    await saveRegistry(registry);
  }

  return registry;
}

export async function saveRegistry(registry: Registry): Promise<void> {
  await atomicWriteText(REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`);
}

export async function backupFile(filePath: string): Promise<string> {
  const backupPath = `${filePath}.bak-${Date.now()}`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await rename(filePath, backupPath).catch(() => {});
  return backupPath;
}
