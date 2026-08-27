import { rename } from "node:fs/promises";
import path from "node:path";
import { GATEWAY_CONF_DIR, MANAGED_SITES_ROOT } from "../paths.js";
import { ensureDir, pathExists, rm } from "../fsutils.js";
import { tryRun } from "../exec.js";
import { saveRegistry } from "../registry/store.js";
import type { Registry, SiteConfig } from "../types.js";

export interface EditOutcome {
  site: SiteConfig;
  notes: string[];
}

/**
 * Persist an edited site. Same key → plain registry update. Changed key →
 *
 *   1. stops the old docker project (best effort) and drops its data volume,
 *   2. relocates managed artifacts (db dumps, certs, snapshots, docker dir,
 *      and wp/ only for managed WordPress paths) to <newKey>/,
 *   3. rewrites localWpPath to the new managed default (custom paths are
 *      left untouched on purpose),
 *   4. removes the stale nginx conf and updates the registry atomically.
 *
 * The wizard has already re-keyed keychain secrets by the time we run.
 */
export async function persistEditedSite(
  registry: Registry,
  oldSite: SiteConfig,
  incoming: SiteConfig,
): Promise<EditOutcome> {
  if (incoming.key === oldSite.key) {
    registry.sites[incoming.key] = incoming;
    await saveRegistry(registry);
    return { site: incoming, notes: [] };
  }

  const notes: string[] = [];
  const oldRoot = path.join(MANAGED_SITES_ROOT, oldSite.key);
  const newRoot = path.join(MANAGED_SITES_ROOT, incoming.key);
  const oldManagedWp = path.join(oldRoot, "wp");
  const isCustomPath = path.resolve(incoming.localWpPath) !== path.resolve(oldManagedWp);

  const next: SiteConfig = { ...incoming };

  if (!isCustomPath) {
    // Managed layout follows the key; rewrite the path so nothing dangles.
    next.localWpPath = path.join(newRoot, "wp");
    next.usingManagedWpPath = true;
  }

  await stopOldStack(oldSite, notes);
  await relocateSubdirs(oldRoot, newRoot, { includeWp: !isCustomPath }, notes);

  // The old nginx server block is stale (writeSiteArtifacts writes the new one).
  await rm(path.join(GATEWAY_CONF_DIR, `${oldSite.key}.conf`), { force: true }).catch(() => {});

  delete registry.sites[oldSite.key];
  registry.sites[next.key] = next;
  if (registry.activeSite === oldSite.key) {
    registry.activeSite = next.key;
  }
  await saveRegistry(registry);

  notes.push(`Relocated managed site storage '${oldSite.key}' → '${next.key}'.`);
  if (isCustomPath) {
    notes.push(
      `Custom WordPress path kept in place:\n${incoming.localWpPath}\n(it was never managed by wp-localify).`,
    );
  }

  return { site: next, notes };
}

/** Best-effort teardown of the renamed project's containers + data volume. */
async function stopOldStack(oldSite: SiteConfig, notes: string[]): Promise<void> {
  const projectName = oldSite.dockerProject || `wp_localify_${oldSite.key.replace(/-/g, "_")}`;
  const oldCompose = path.join(MANAGED_SITES_ROOT, oldSite.key, "docker", "docker-compose.yml");

  try {
    if (await pathExists(oldCompose)) {
      await tryRun("docker", ["compose", "-p", projectName, "-f", oldCompose, "down", "--remove-orphans"]);
    }
    await tryRun("docker", ["volume", "rm", `${projectName}_db_data`]);
  } catch {
    // Renaming must proceed even when Docker is unreachable.
    notes.push("Old docker stack was not stopped (Docker unreachable?). Inspect with `docker ps`.");
  }
}

const MOVED_SUBDIRS = ["wp", "db", "certs", "snapshots", "docker"] as const;

async function relocateSubdirs(
  oldRoot: string,
  newRoot: string,
  options: { includeWp: boolean },
  notes: string[],
): Promise<void> {
  await ensureDir(newRoot);

  for (const sub of MOVED_SUBDIRS) {
    if (sub === "wp" && !options.includeWp) continue;

    const source = path.join(oldRoot, sub);
    if (!(await pathExists(source))) continue;

    const target = path.join(newRoot, sub);
    // A half-initialized target would block rename(); clear it first.
    await rm(target, { recursive: true, force: true }).catch(() => {});

    try {
      await rename(source, target);
    } catch {
      try {
        const fs = await import("node:fs/promises");
        await fs.cp(source, target, { recursive: true });
        await rm(source, { recursive: true, force: true });
      } catch {
        notes.push(`Could not relocate ${sub}: ${source}`);
        continue;
      }
    }
  }

  await rm(oldRoot, { recursive: true, force: true });
}
