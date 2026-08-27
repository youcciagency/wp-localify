import { note, outro } from "@clack/prompts";
import type { Command } from "commander";
import { startSpinner } from "../ui/spinner.js";
import { createSudoSpinnerHooks, writeSiteArtifacts } from "../site/artifacts.js";
import { buildSiteContext } from "../site/context.js";
import { importAndReplace, importDb, replaceUrls, hasDbFiles } from "../wordpress/import.js";
import { hasWpFiles } from "../wordpress/wpconfig.js";
import { pullFiles } from "../wordpress/pull-files.js";
import { pullDb } from "../wordpress/pull-db.js";
import { resolveSiteSecrets } from "../secrets/keychain.js";
import { addSiteOptions, loadSiteForAction } from "./shared.js";

function addSkipUp(cmd: Command): Command {
  return cmd.option("--skip-up", "Skip starting containers if already running");
}

export function registerImportCommands(program: Command): void {
  addSkipUp(
    addSiteOptions(program.command("import").description("Start stack + import DB + replace URLs")),
  ).action(async (options: { site?: string; reconfigure?: boolean; skipUp?: boolean }) => {
    const { settings, site } = await loadSiteForAction(options);
    const ctx = buildSiteContext(site);

    const spinner = startSpinner("Importing database and replacing URLs...");
    await importAndReplace(site, ctx, settings, options.skipUp === true);
    spinner.stop("Import completed.");
    outro(`Open: https://${site.localDomain}`);
  });

  addSkipUp(addSiteOptions(program.command("import-db").description("Import database only"))).action(
    async (options: { site?: string; reconfigure?: boolean; skipUp?: boolean }) => {
      const { settings, site } = await loadSiteForAction(options);
      const ctx = buildSiteContext(site);

      const spinner = startSpinner("Importing database...");
      await importDb(site, ctx, settings, options.skipUp === true);
      spinner.stop("Database imported.");
      outro("Done. Run 'wp-localify replace-urls' next.");
    },
  );

  addSiteOptions(
    program.command("replace-urls").description("Replace remote URLs with local site URL"),
  ).action(async (options: { site?: string; reconfigure?: boolean }) => {
    const { settings, site } = await loadSiteForAction(options);
    const ctx = buildSiteContext(site);

    const spinner = startSpinner("Replacing URLs...");
    await replaceUrls(site, ctx, settings);
    spinner.stop("URLs replaced.");
    outro(`Open: https://${site.localDomain}`);
  });

  addSiteOptions(program.command("all").description("init + pull + import for one site")).action(
    async (options: { site?: string; reconfigure?: boolean }) => {
      const { settings, site } = await loadSiteForAction(options);
      const ctx = buildSiteContext(site);

      const spinner = startSpinner("Init...");
      const sudoHooks = createSudoSpinnerHooks({ spinner, resumeMessage: "Init..." });
      await writeSiteArtifacts(site, settings, {
        checkDependencies: true,
        onProgress: (message) => spinner.message(`Init: ${message}`),
        ...sudoHooks,
      });
      spinner.stop("Init done.");

      const wpExists = await hasWpFiles(ctx);
      const dbExists = await hasDbFiles(ctx);

      if (wpExists && dbExists) {
        note("Found existing files and dump. Skipping pull.", "Files Found");
      } else {
        if (!wpExists) {
          const secrets = site.downloadProtocol === "ftp" ? await resolveSiteSecrets(site.key) : null;
          const pullSpinner = startSpinner("Pulling files...");
          await pullFiles(site, ctx, { ftpPassword: secrets?.remoteFtpPass });
          pullSpinner.stop("Files pulled.");
        } else {
          note("Skipping files: wp-config.php already exists.", "Skip");
        }

        if (!dbExists) {
          const dumpSpinner = startSpinner("Exporting database...");
          await pullDb(site, ctx);
          dumpSpinner.stop("Database exported.");
        } else {
          note("Skipping DB export: dump already exists.", "Skip");
        }
      }

      const importSpinner = startSpinner("Importing database and replacing URLs...");
      await importAndReplace(site, ctx, settings);
      importSpinner.stop("Import done.");

      outro(`Done. Open: https://${site.localDomain}`);
    },
  );
}
