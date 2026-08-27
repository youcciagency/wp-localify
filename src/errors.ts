import process from "node:process";
import { cancel as clackCancel } from "@clack/prompts";
import { stopActiveSpinner } from "./ui/spinner.js";

export class CliError extends Error {
  readonly exitCode: number;
  readonly hint?: string;

  constructor(message: string, options: { exitCode?: number; hint?: string } = {}) {
    super(message);
    this.name = "CliError";
    this.exitCode = options.exitCode ?? 1;
    this.hint = options.hint;
  }
}

export const EXIT_CODE_INTERRUPTED = 130;

type CleanupFn = () => void | Promise<void>;

const cleanups: CleanupFn[] = [];
let exiting = false;

export function registerCleanup(fn: CleanupFn): void {
  cleanups.push(fn);
}

async function runCleanups(): Promise<void> {
  for (const fn of cleanups.splice(0)) {
    try {
      await fn();
    } catch {
      // best-effort cleanup; never mask the original error
    }
  }
}

export async function exitWithError(error: unknown): Promise<never> {
  if (exiting) {
    process.exit(1);
  }
  exiting = true;

  stopActiveSpinner();
  await runCleanups();

  if (error instanceof CliError) {
    console.error(`\n❌ ${error.message}`);
    if (error.hint) {
      console.error(`\n💡 ${error.hint}`);
    }
    process.exit(error.exitCode);
  }

  if (process.env.WP_LOCALIFY_DEBUG === "1" || process.env.WP_LOCALIFY_DEBUG === "true") {
    console.error("\nUnhandled error:");
    console.error(error);
  } else if (error instanceof Error && error.message) {
    console.error(`\n❌ ${error.message}`);
    console.error("\nRe-run with WP_LOCALIFY_DEBUG=1 for the full stack trace.");
  } else {
    console.error(`\n❌ Unexpected error: ${String(error)}`);
  }
  process.exit(1);
}

export async function exitCancelled(message = "Aborted."): Promise<never> {
  if (!exiting) {
    clackCancel(message);
  }
  stopActiveSpinner();
  await runCleanups();
  process.exit(EXIT_CODE_INTERRUPTED);
}

/**
 * Synchronous cancel-and-exit for prompt loops where control-flow narrowing
 * matters (`process.exit` never returns).
 */
export function cancelNow(message = "Aborted."): never {
  clackCancel(message);
  stopActiveSpinner();
  process.exit(EXIT_CODE_INTERRUPTED);
}
