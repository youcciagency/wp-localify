import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import * as updateNotifierModule from "simple-update-notifier";
import pkg from "../package.json" with { type: "json" };
import { applyGlobalFlags } from "./ui/env.js";
import { abortAllProcesses, isAborted } from "./exec.js";
import { EXIT_CODE_INTERRUPTED, exitWithError } from "./errors.js";
import { assertSupportedPlatform } from "./system/platform.js";
import { stopActiveSpinner } from "./ui/spinner.js";
import {
  registerConfigCommand,
  registerCheckCommand,
  registerInitCommand,
  registerPullCommands,
} from "./commands/lifecycle.js";
import { registerImportCommands } from "./commands/importing.js";
import { registerSiteCommands } from "./commands/site.js";
import { registerUtilityCommands } from "./commands/extras.js";
import { registerCompletionCommands } from "./commands/completions.js";

interface UpdateNotifierArgs {
  pkg: { name: string; version: string };
}

function maybeNotifyUpdates(): void {
  if (!process.stdout.isTTY || process.env.WP_LOCALIFY_NO_UPDATE_CHECK === "1") return;
  try {
    // CJS module: default interop shape varies, resolve both.
    const mod = updateNotifierModule as unknown as {
      default?: (args: UpdateNotifierArgs) => Promise<void>;
    };
    const notify =
      mod.default ?? (updateNotifierModule as unknown as (args: UpdateNotifierArgs) => Promise<void>);
    void notify({ pkg: pkg as unknown as { name: string; version: string } });
  } catch {
    // update checks must never break the CLI
  }
}

/** Wire every command and option. Exported for integration tests. */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name("wp-localify")
    .description("Pull live WordPress sites into local Docker environments — multi-site, HTTPS, one CLI.")
    .version(pkg.version)
    .showHelpAfterError("(run 'wp-localify --help' for a list of commands)")
    .option("-y, --yes", "Accept confirmation prompts (non-interactive safe)")
    .option("--json", "Machine-readable JSON output where supported")
    .option("-v, --verbose", "Print underlying commands as they run")
    .option("-q, --quiet", "Reduce output");

  program.hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts<{
      yes?: boolean;
      json?: boolean;
      verbose?: boolean;
      quiet?: boolean;
    }>();
    applyGlobalFlags({
      yes: opts.yes === true,
      json: opts.json === true,
      verbose: opts.verbose === true,
      quiet: opts.quiet === true,
    });
  });

  registerConfigCommand(program);
  registerCheckCommand(program);
  registerInitCommand(program);
  registerPullCommands(program);
  registerImportCommands(program);
  registerSiteCommands(program);
  registerUtilityCommands(program);
  registerCompletionCommands(program);

  program.addHelpText(
    "after",
    [
      "",
      "Typical flow:",
      "  wp-localify site add        # one-time wizard per site",
      "  wp-localify pull            # fetch files + database",
      "  wp-localify import          # start stack, import DB, rewrite URLs",
      "  wp-localify open            # https://<site>.test",
      "",
      "Secrets (DB/FTP passwords) are stored in your OS keychain, never in sites.json.",
    ].join("\n"),
  );

  return program;
}

async function main(): Promise<void> {
  assertSupportedPlatform();
  maybeNotifyUpdates();

  const program = buildProgram();

  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (isAborted()) {
      stopActiveSpinner();
      process.exit(EXIT_CODE_INTERRUPTED);
    }
    await exitWithError(error);
  }
}

// Only boot when executed directly — importing this module (tests, tooling)
// must stay side-effect free.
function isEntryModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    const entryPath = path.resolve(process.argv[1]);
    return import.meta.url === pathToFileURL(entryPath).href;
  } catch {
    return false;
  }
}

if (isEntryModule()) {
  process.on("SIGINT", () => {
    abortAllProcesses("SIGINT");
    stopActiveSpinner();
    // Give execa children a moment to die, then exit.
    setTimeout(() => process.exit(EXIT_CODE_INTERRUPTED), 150);
  });

  process.on("unhandledRejection", (reason) => {
    void exitWithError(reason);
  });

  process.on("uncaughtException", (error) => {
    void exitWithError(error);
  });

  await main();
}
