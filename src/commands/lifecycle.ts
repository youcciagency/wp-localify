import { note, outro } from "@clack/prompts";
import type { Command } from "commander";
import { CliError } from "../errors.js";
import { loadRegistry, saveRegistry } from "../registry/store.js";
import { requireSite } from "../registry/select.js";
import { promptSiteConfig } from "../ui/prompts.js";
import { startSpinner } from "../ui/spinner.js";
import { persistEditedSite } from "../site/rename.js";
import { createSudoSpinnerHooks, writeSiteArtifacts } from "../site/artifacts.js";
import { buildSiteContext } from "../site/context.js";
import { checkDependencies } from "../system/deps.js";
import { pullFiles } from "../wordpress/pull-files.js";
import { pullDb } from "../wordpress/pull-db.js";
import { hasDbFiles } from "../wordpress/import.js";
import { hasWpFiles } from "../wordpress/wpconfig.js";
import { resolveSiteSecrets } from "../secrets/keychain.js";
import { addSiteOptions, loadSiteForAction } from "./shared.js";

export function registerConfigCommand(program: Command): void {
  program
    .command("config")
    .description("Create first site config or edit an existing one")
    .option("--site <key>", "Site key (defaults to active site)")
    .action(async (options: { site?: string }) => {
      const registry = await loadRegistry();

      if (Object.keys(registry.sites).length === 0) {
        const site = await promptSiteConfig(null, registry, "add");
        registry.sites[site.key] = site;
        registry.activeSite = site.key;
        await saveRegistry(registry);
        outro(`Saved config for site '${site.key}'.`);
        return;
      }

      const site = await requireSite(registry, options.site, "Select site to edit");
      const updated = await promptSiteConfig(site, registry, "edit");

      if (updated.key !== site.key) {
        const outcome = await persistEditedSite(registry, site, updated);
        for (const noteText of outcome.notes) {
          note(noteText, "Rename");
        }
        outro(`Saved config for site '${outcome.site.key}'.`);
        return;
      }

      registry.sites[updated.key] = updated;
      if (!registry.activeSite) {
        registry.activeSite = updated.key;
      }
      await saveRegistry(registry);
      outro(`Saved config for site '${updated.key}'.`);
    });
}

export function registerCheckCommand(program: Command): void {
  program
    .command("check")
    .description("Check required dependencies")
    .option("--site <key>", "Site key (optional)")
    .action(async (options: { site?: string }) => {
      const registry = await loadRegistry();
      let site = null;
      if (Object.keys(registry.sites).length > 0) {
        site = await requireSite(registry, options.site, "Select site for dependency check");
      }

      const spinner = startSpinner("Checking dependencies...");
      const result = await checkDependencies(
        site,
        {
          needsMkcert: true,
          needsMysqldump: true,
          needsRsync: site?.downloadProtocol === "ssh",
          needsLftp: site?.downloadProtocol === "ftp",
        },
        false,
      );

      if (result.success) {
        spinner.stop("All dependencies are installed.");
        outro("Ready to go.");
        return;
      }

      spinner.stop("Some dependencies are missing.");
      throw new CliError(result.message);
    });
}

export function registerInitCommand(program: Command): void {
  addSiteOptions(
    program.command("init").description("Generate site stack, certs, hosts entry, and gateway config"),
  ).action(async (options: { site?: string; reconfigure?: boolean }) => {
    const { settings, site } = await loadSiteForAction(options);
    const spinner = startSpinner(`Initializing site '${site.key}'...`);
    const sudoHooks = createSudoSpinnerHooks({
      spinner,
      resumeMessage: `Initializing site '${site.key}'...`,
    });

    await writeSiteArtifacts(site, settings, {
      checkDependencies: true,
      onProgress: (message) => spinner.message(message),
      ...sudoHooks,
    });

    spinner.stop("Initialized.");
    outro(`Open: https://${site.localDomain}`);
  });
}

export function registerPullCommands(program: Command): void {
  addSiteOptions(program.command("pull").description("Pull WP files + export DB for one site")).action(
    async (options: { site?: string; reconfigure?: boolean }) => {
      const { site } = await loadSiteForAction(options);
      const ctx = buildSiteContext(site);

      const wpExists = await hasWpFiles(ctx);
      const dbExists = await hasDbFiles(ctx);

      if (!wpExists) {
        const spinner = startSpinner("Pulling files...");
        const secrets = site.downloadProtocol === "ftp" ? await resolveSiteSecrets(site.key) : null;
        await pullFiles(site, ctx, { ftpPassword: secrets?.remoteFtpPass });
        spinner.stop("Files pulled.");
      } else {
        note("Skipping files: wp-config.php already exists.", "Skip");
      }

      if (!dbExists) {
        const spinner = startSpinner("Exporting database...");
        await pullDb(site, ctx);
        spinner.stop("Database exported.");
      } else {
        note("Skipping DB export: dump.sql.gz already exists.", "Skip");
      }

      outro("Done.");
    },
  );

  addSiteOptions(program.command("pull-files").description("Pull WP files only")).action(
    async (options: { site?: string; reconfigure?: boolean }) => {
      const { site } = await loadSiteForAction(options);
      const ctx = buildSiteContext(site);

      if (await hasWpFiles(ctx)) {
        note("Skipping file download: wp-config.php already exists.", "Skip");
        outro("Done.");
        return;
      }

      const spinner = startSpinner("Pulling files...");
      const secrets = site.downloadProtocol === "ftp" ? await resolveSiteSecrets(site.key) : null;
      await pullFiles(site, ctx, { ftpPassword: secrets?.remoteFtpPass });
      spinner.stop("Files pulled.");
      outro("Done.");
    },
  );

  program
    .command("pull-db")
    .description("Export the remote database only")
    .option("--site <key>", "Site key (defaults to active site)")
    .option("--reconfigure", "Prompt and update site config first")
    .option("--via <mode>", "'direct' or 'ssh-tunnel' (overrides the site's dbAccess setting)")
    .action(async (options: { site?: string; reconfigure?: boolean; via?: string }) => {
      const { site } = await loadSiteForAction(options);
      const ctx = buildSiteContext(site);

      let via: "direct" | "ssh-tunnel" | undefined;
      if (options.via) {
        if (options.via !== "direct" && options.via !== "ssh-tunnel") {
          throw new CliError("--via must be 'direct' or 'ssh-tunnel'.", {
            hint: "Example: wp-localify pull-db --via ssh-tunnel",
          });
        }
        via = options.via;
      }

      if ((await hasDbFiles(ctx)) && !via && (site.dbAccess ?? "direct") === "direct") {
        note("Skipping DB export: dump.sql.gz already exists.", "Skip");
        outro("Done.");
        return;
      }

      const spinner = startSpinner(
        via === "ssh-tunnel" || (!via && site.dbAccess === "ssh-tunnel")
          ? "Exporting database (over SSH tunnel)..."
          : "Exporting database...",
      );
      await pullDb(site, ctx, { via });
      spinner.stop("Database exported.");
      outro("Done.");
    });
}
