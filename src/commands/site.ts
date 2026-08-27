import { cancel, confirm, note, outro } from "@clack/prompts";
import type { Command } from "commander";
import { CliError, exitCancelled } from "../errors.js";
import { loadRegistry, saveRegistry } from "../registry/store.js";
import { requireSite } from "../registry/select.js";
import { promptSiteConfig } from "../ui/prompts.js";
import { startSpinner } from "../ui/spinner.js";
import { canPrompt, globalFlags } from "../ui/env.js";
import { renderStatus } from "../ui/render.js";
import {
  collectSiteStatus,
  createSudoSpinnerHooks,
  downSite,
  upSite,
  writeSiteArtifacts,
} from "../site/artifacts.js";
import { buildSiteContext } from "../site/context.js";
import { removeHostsEntry } from "../system/hosts.js";
import { ensureGatewayInfrastructure, isGatewayRunning } from "../docker/gateway.js";
import { deleteSiteSecrets } from "../secrets/keychain.js";
import { persistEditedSite } from "../site/rename.js";
import { rm } from "../fsutils.js";
import type { Registry, SiteConfig } from "../types.js";

async function pickSite(registry: Registry, key: string | undefined, message: string): Promise<SiteConfig> {
  return requireSite(registry, key, message);
}

export function registerSiteCommands(program: Command): void {
  const site = program.command("site").description("Manage multiple local sites");

  site
    .command("add")
    .description("Add and initialize a new site")
    .action(async () => {
      const registry = await loadRegistry();
      const created = await promptSiteConfig(null, registry, "add");

      registry.sites[created.key] = created;
      if (!registry.activeSite) {
        registry.activeSite = created.key;
      }
      await saveRegistry(registry);

      const spinner = startSpinner(`Initializing site '${created.key}'...`);
      const sudoHooks = createSudoSpinnerHooks({
        spinner,
        resumeMessage: `Initializing site '${created.key}'...`,
      });
      await writeSiteArtifacts(created, registry.settings, {
        checkDependencies: true,
        onProgress: (message) => spinner.message(message),
        ...sudoHooks,
      });
      spinner.stop("Site added.");

      outro(`Added site '${created.key}'. Open: https://${created.localDomain}`);
    });

  site
    .command("list")
    .description("List all configured sites")
    .action(async () => {
      const registry = await loadRegistry();
      renderSiteList(registry);
      outro("Done.");
    });

  site
    .command("use [key]")
    .description("Set active site")
    .action(async (key: string | undefined) => {
      const registry = await loadRegistry();
      const target = await pickSite(registry, key, "Select site to set as active");
      registry.activeSite = target.key;
      await saveRegistry(registry);
      outro(`Active site set to '${target.key}'.`);
    });

  site
    .command("status")
    .description("Show status for all sites or one site")
    .option("--site <key>", "Site key (defaults to all sites)")
    .action(async (options: { site?: string }) => {
      const registry = await loadRegistry();
      const targets: SiteConfig[] = options.site
        ? [await pickSite(registry, options.site, "Select site")]
        : Object.values(registry.sites);

      // Independent sites → collect their status concurrently.
      const statuses = await Promise.all(targets.map((target) => collectSiteStatus(target)));

      const payload = {
        activeSite: registry.activeSite,
        gatewayRunning: await isGatewayRunning(),
        sites: statuses,
      };

      if (globalFlags.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      note(renderStatus(payload.activeSite, payload.gatewayRunning, statuses), "Status");
      outro("Done.");
    });

  site
    .command("start")
    .description("Start one site")
    .option("--site <key>", "Site key (defaults to active site)")
    .action(async (options: { site?: string }) => {
      const registry = await loadRegistry();
      const target = await pickSite(registry, options.site, "Select site to start");
      const ctx = buildSiteContext(target);

      const spinner = startSpinner(`Starting '${target.key}'...`);
      await upSite(target, ctx, registry.settings);
      spinner.stop("Started.");
      outro(`Open: https://${target.localDomain}`);
    });

  site
    .command("stop")
    .description("Stop one site")
    .option("--site <key>", "Site key (defaults to active site)")
    .action(async (options: { site?: string }) => {
      const registry = await loadRegistry();
      const target = await pickSite(registry, options.site, "Select site to stop");
      const ctx = buildSiteContext(target);

      const spinner = startSpinner(`Stopping '${target.key}'...`);
      await downSite(ctx, false);
      spinner.stop("Stopped.");
      outro(`Stopped '${target.key}'.`);
    });

  site
    .command("restart")
    .description("Restart one site")
    .option("--site <key>", "Site key (defaults to active site)")
    .action(async (options: { site?: string }) => {
      const registry = await loadRegistry();
      const target = await pickSite(registry, options.site, "Select site to restart");
      const ctx = buildSiteContext(target);

      const spinner = startSpinner(`Restarting '${target.key}'...`);
      await downSite(ctx, false);
      await upSite(target, ctx, registry.settings);
      spinner.stop("Restarted.");
      outro(`Open: https://${target.localDomain}`);
    });

  site
    .command("edit")
    .description("Edit one site's configuration (including its key)")
    .option("--site <key>", "Site key (defaults to active site)")
    .action(async (options: { site?: string }) => {
      const registry = await loadRegistry();
      const target = await pickSite(registry, options.site, "Select site to edit");
      const oldDomain = target.localDomain;

      const updated = await promptSiteConfig(target, registry, "edit");

      let finalSite = updated;
      if (updated.key !== target.key) {
        const outcome = await persistEditedSite(registry, target, updated);
        finalSite = outcome.site;
        for (const noteText of outcome.notes) {
          note(noteText, "Rename");
        }
      } else {
        registry.sites[finalSite.key] = finalSite;
        await saveRegistry(registry);
      }

      const ctx = buildSiteContext(finalSite);
      if (oldDomain !== finalSite.localDomain) {
        await removeHostsEntry(oldDomain).catch(() => {});
        // Old cert is invalid for the new domain; artifacts already live under
        // the (possibly new) key so regenerate.
        await rm(ctx.files.certPem, { force: true });
        await rm(ctx.files.certKey, { force: true });
      }

      const spinner = startSpinner("Rebuilding site artifacts...");
      const sudoHooks = createSudoSpinnerHooks({ spinner, resumeMessage: "Rebuilding site artifacts..." });
      await writeSiteArtifacts(finalSite, registry.settings, {
        checkDependencies: true,
        onProgress: (message) => spinner.message(message),
        ...sudoHooks,
      });
      spinner.stop("Updated.");

      outro(`Updated '${finalSite.key}'. Open: https://${finalSite.localDomain}`);
    });

  site
    .command("remove")
    .description("Remove a site (safe by default; data kept unless --purge)")
    .option("--site <key>", "Site key (defaults to active site)")
    .option("--purge", "Delete managed site data and Docker volumes")
    .option("--yes", "Skip confirmation")
    .action(async (options: { site?: string; purge?: boolean; yes?: boolean }) => {
      const registry = await loadRegistry();
      const target = await pickSite(registry, options.site, "Select site to remove");
      const ctx = buildSiteContext(target);

      const confirmed =
        options.yes || globalFlags.yes ? true : await confirmOrAbort(options.purge === true, target);

      if (!confirmed) {
        cancel("Aborted.");
        process.exit(0);
      }

      const spinner = startSpinner(`Removing '${target.key}'...`);
      const sudoHooks = createSudoSpinnerHooks({ spinner, resumeMessage: `Removing '${target.key}'...` });

      await downSite(ctx, options.purge === true);
      await rm(ctx.files.nginxConf, { force: true });
      await removeHostsEntry(target.localDomain, sudoHooks).catch(() => {});
      await deleteSiteSecrets(target.key).catch(() => {});

      if (options.purge) {
        await rm(ctx.dirs.storageRoot, { recursive: true, force: true });
        if (!target.usingManagedWpPath) {
          note(
            `Custom WordPress path was not deleted:\n${target.localWpPath}\nDelete it manually if needed.`,
            "Custom Path",
          );
        }
      }

      delete registry.sites[target.key];
      if (registry.activeSite === target.key) {
        const remaining = Object.keys(registry.sites);
        registry.activeSite = remaining.length > 0 ? (remaining[0] ?? null) : null;
      }
      await saveRegistry(registry);

      await ensureGatewayInfrastructure(registry.settings, { quiet: true });

      spinner.stop("Removed.");
      outro(`Removed '${target.key}'.`);
    });

  site
    .command("start-all")
    .description("Start all configured sites")
    .action(async () => {
      const registry = await loadRegistry();
      const targets = Object.values(registry.sites);
      assertHasSites(targets.length);

      for (const target of targets) {
        const spinner = startSpinner(`Starting '${target.key}'...`);
        try {
          await upSite(target, buildSiteContext(target), registry.settings);
          spinner.stop(`Started '${target.key}'.`);
        } catch (error) {
          spinner.stop(`Failed to start '${target.key}'.`);
          throw error;
        }
      }
      outro("All sites started.");
    });

  site
    .command("stop-all")
    .description("Stop all configured sites")
    .action(async () => {
      const registry = await loadRegistry();
      const targets = Object.values(registry.sites);
      assertHasSites(targets.length);

      for (const target of targets) {
        const spinner = startSpinner(`Stopping '${target.key}'...`);
        try {
          await downSite(buildSiteContext(target), false);
          spinner.stop(`Stopped '${target.key}'.`);
        } catch (error) {
          spinner.stop(`Failed to stop '${target.key}'.`);
          throw error;
        }
      }
      outro("All sites stopped.");
    });
}

function assertHasSites(count: number): void {
  if (count === 0) {
    throw new CliError("No sites configured.", { hint: "Run `wp-localify site add` to create one." });
  }
}

function renderSiteList(registry: Registry): void {
  const keys = Object.keys(registry.sites);
  if (keys.length === 0) {
    note("No sites configured yet. Run: wp-localify site add", "Sites");
    return;
  }

  const lines = keys.map((key) => {
    const target = registry.sites[key];
    if (!target) return `  ${key}`;
    const activeMarker = registry.activeSite === key ? "*" : " ";
    return `${activeMarker} ${key.padEnd(14)} ${target.localDomain.padEnd(24)} ${target.downloadProtocol.toUpperCase()} ${target.localWpPath}`;
  });

  note(lines.join("\n"), "Sites (* = active)");
}

async function confirmOrAbort(purge: boolean, target: SiteConfig): Promise<boolean> {
  if (!canPrompt()) {
    throw new CliError("Refusing to remove a site without --yes in a non-interactive session.", {
      hint: "Re-run with --yes to skip the confirmation prompt.",
    });
  }

  const keepText = purge
    ? "This will remove containers, registry entry, secrets, and managed data."
    : "This will remove containers, secrets, and registry entry — files/dumps/certs are kept.";

  note(`${keepText}\nSite: ${target.key} (${target.localDomain})`, "Confirm Removal");

  const proceed = await confirm({ message: `Remove site '${target.key}'?`, initialValue: false });
  if (typeof proceed === "symbol") {
    await exitCancelled();
  }
  return proceed === true;
}
