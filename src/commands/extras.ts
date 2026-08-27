import { note, outro } from "@clack/prompts";
import type { Command } from "commander";
import { CliError } from "../errors.js";
import { loadRegistry } from "../registry/store.js";
import {
  assertGatewayPortsFree,
  ensureDockerNetwork,
  isGatewayRunning,
  writeGatewayFiles,
} from "../docker/gateway.js";
import { runGatewayComposeMaybe, runSiteCompose } from "../docker/compose.js";
import { openInBrowser } from "../system/platform.js";
import { buildSiteContext } from "../site/context.js";
import { runWpCli } from "../wordpress/import.js";
import { exportLocalDbSnapshot } from "../wordpress/db-export.js";
import { shQuote } from "../text.js";
import { addSiteOptions, loadSiteForAction } from "./shared.js";

const KNOWN_SERVICES = ["db", "wordpress", "wpcli"] as const;

export function registerUtilityCommands(program: Command): void {
  program
    .command("logs")
    .description("Show container logs for a site (default service: wordpress)")
    .option("--site <key>", "Site key (defaults to active site)")
    .option("-f, --follow", "Follow log output")
    .argument("[service]", `${KNOWN_SERVICES.join(" | ")}`)
    .action(async (service: string | undefined, options: { site?: string; follow?: boolean }) => {
      const { site } = await loadSiteForAction({ site: options.site });
      const ctx = buildSiteContext(site);

      const target = service ?? "wordpress";
      if (!(KNOWN_SERVICES as readonly string[]).includes(target)) {
        throw new CliError(`Unknown service '${target}'.`, {
          hint: `Valid services: ${KNOWN_SERVICES.join(", ")}`,
        });
      }

      await runSiteCompose(ctx, ["logs", ...(options.follow ? ["-f"] : []), target]);
    });

  addSiteOptions(program.command("open").description("Open the site in your browser")).action(
    async (options: { site?: string; reconfigure?: boolean }) => {
      const { site } = await loadSiteForAction(options);
      await openInBrowser(`https://${site.localDomain}`);
      outro(`Opened https://${site.localDomain}`);
    },
  );

  program
    .command("wp [args...]")
    .allowUnknownOption(true)
    .description("Run any WP-CLI command inside the site container")
    .option("--site <key>", "Site key (defaults to active site)")
    .action(async (wpArgs: string[], options: { site?: string }) => {
      if (wpArgs.length === 0) {
        throw new CliError("No WP-CLI arguments given.", {
          hint: "Example: wp-localify wp plugin list",
        });
      }
      const { site } = await loadSiteForAction({ site: options.site });
      const ctx = buildSiteContext(site);

      // The wpcli container entrypoint is `sh -lc`, so the whole command is
      // passed through as one safely quoted argument.
      const joined = wpArgs.map((arg) => String(arg)).join(" ");
      await runWpCli(ctx, shQuote(joined));
      outro("");
    });

  addSiteOptions(program.command("shell").description("Open a bash shell in the WordPress container")).action(
    async (options: { site?: string; reconfigure?: boolean }) => {
      const { site } = await loadSiteForAction(options);
      const ctx = buildSiteContext(site);
      await runSiteCompose(ctx, ["exec", "wordpress", "bash"]);
      outro("");
    },
  );

  addSiteOptions(
    program.command("db-export").description("Snapshot the local database to <storage>/snapshots"),
  ).action(async (options: { site?: string; reconfigure?: boolean }) => {
    const { site } = await loadSiteForAction(options);
    const outPath = await exportLocalDbSnapshot(site);
    outro(`Snapshot written to ${outPath}`);
  });

  const gateway = program.command("gateway").description("Manage the shared nginx HTTPS gateway");

  gateway
    .command("start")
    .description("Start the shared gateway")
    .action(async () => {
      const registry = await loadRegistry();
      await writeGatewayFiles(registry.settings);
      await upGateway(registry.settings);
      outro("Gateway started.");
    });

  gateway
    .command("stop")
    .description("Stop the shared gateway")
    .action(async () => {
      await runGatewayComposeMaybe(["down", "--remove-orphans"]);
      outro("Gateway stopped.");
    });

  gateway
    .command("restart")
    .description("Restart the shared gateway")
    .action(async () => {
      const registry = await loadRegistry();
      await writeGatewayFiles(registry.settings);
      await runGatewayComposeMaybe(["down", "--remove-orphans"]);
      await upGateway(registry.settings);
      outro("Gateway restarted.");
    });

  gateway
    .command("status")
    .description("Show whether the shared gateway is running")
    .action(async () => {
      const registry = await loadRegistry();
      const running = await isGatewayRunning();
      note(
        `gateway: ${running ? "running" : "stopped"} (http:${registry.settings.httpPort} https:${registry.settings.httpsPort})`,
        "Gateway",
      );
    });
}

async function upGateway(settings: { httpPort: number; httpsPort: number }): Promise<void> {
  await assertGatewayPortsFree(settings);
  await ensureDockerNetwork();
  await runGatewayComposeMaybe(["up", "-d"]);
}
