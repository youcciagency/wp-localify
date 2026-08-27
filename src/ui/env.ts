import process from "node:process";
import { confirm } from "@clack/prompts";
import { cancelNow, CliError } from "../errors.js";

export interface GlobalFlags {
  yes: boolean;
  json: boolean;
  verbose: boolean;
  quiet: boolean;
}

export const globalFlags: GlobalFlags = {
  yes: false,
  json: false,
  verbose: false,
  quiet: false,
};

export function applyGlobalFlags(flags: GlobalFlags): void {
  globalFlags.yes = flags.yes;
  globalFlags.json = flags.json;
  globalFlags.verbose = flags.verbose || process.env.WP_LOCALIFY_VERBOSE === "1";
  globalFlags.quiet = flags.quiet;
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function nonInteractiveEnforced(): boolean {
  return process.env.WP_LOCALIFY_NONINTERACTIVE === "1";
}

/** True when prompts may be shown. */
export function canPrompt(): boolean {
  return isInteractive() && !nonInteractiveEnforced();
}

export function requirePromptCapability(action: string): void {
  if (!canPrompt()) {
    throw new CliError(`'${action}' needs an interactive terminal or explicit flags.`, {
      hint: "Re-run inside a TTY, or set WP_LOCALIFY_NONINTERACTIVE=1 and pass all required flags (e.g. --site <key>, --yes).",
    });
  }
}

/**
 * Confirmation gate that respects --yes / WP_LOCALIFY_YES and fails closed in
 * non-interactive environments instead of hanging on a prompt.
 */
export async function confirmOrThrow(
  message: string,
  options: { initialValue?: boolean } = {},
): Promise<boolean> {
  if (globalFlags.yes || process.env.WP_LOCALIFY_YES === "1") {
    return true;
  }
  if (!canPrompt()) {
    throw new CliError(`Refusing to prompt for confirmation in a non-interactive session: ${message}`, {
      hint: "Pass --yes to accept, or run interactively.",
    });
  }
  const result = await confirm({ message, initialValue: options.initialValue ?? false });
  if (typeof result === "symbol") {
    cancelNow();
  }
  return result === true;
}
