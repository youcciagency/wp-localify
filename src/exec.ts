import { execa, type Options as ExecaOptions, type ResultPromise } from "execa";

let aborted = false;
const abortController = new AbortController();

export function abortAllProcesses(reason = "interrupted"): void {
  if (aborted) return;
  aborted = true;
  abortController.abort(new Error(reason));
}

export function isAborted(): boolean {
  return aborted;
}

function baseOptions(): ExecaOptions {
  return { cancelSignal: abortController.signal };
}

export function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return "";
}

export interface RunOutput {
  stdout: string;
  stderr: string;
}

export interface TryResult extends RunOutput {
  ok: boolean;
}

function isCancellation(error: unknown): boolean {
  return aborted || (error instanceof Error && (error.name === "AbortError" || error.name === "CancelError"));
}

/** Run a command inheriting stdio so interactive tools work. Throws on failure. */
export function run(file: string, args: string[], options: ExecaOptions = {}): ResultPromise {
  logVerbose(file, args);
  return execa(file, args, { ...baseOptions(), stdio: "inherit", ...options });
}

/** Run a command capturing output. Throws on failure. */
export async function runQuiet(file: string, args: string[], options: ExecaOptions = {}): Promise<RunOutput> {
  logVerbose(file, args);
  const result = await execa(file, args, { ...baseOptions(), ...options });
  return { stdout: asString(result.stdout), stderr: asString(result.stderr) };
}

/** Run a command capturing output; failures become `{ ok: false }` instead of throwing. */
export async function tryRun(file: string, args: string[], options: ExecaOptions = {}): Promise<TryResult> {
  try {
    const result = await runQuiet(file, args, options);
    return { ok: true, ...result };
  } catch (error) {
    if (isCancellation(error)) throw error;
    const err = error as { stdout?: unknown; stderr?: unknown };
    return { ok: false, stdout: asString(err.stdout), stderr: asString(err.stderr) };
  }
}

/**
 * Escape hatch for commands that genuinely need a shell (grep with POSIX
 * classes). Input must already be safely quoted.
 */
export function runShell(script: string, options: ExecaOptions = {}): ResultPromise {
  logVerboseShell(script);
  return execa(script, { ...baseOptions(), shell: true, stdio: "inherit", ...options });
}

export async function runShellQuiet(script: string, options: ExecaOptions = {}): Promise<RunOutput> {
  logVerboseShell(script);
  const result = await execa(script, { ...baseOptions(), shell: true, ...options });
  return { stdout: asString(result.stdout), stderr: asString(result.stderr) };
}

export async function runShellMaybe(script: string, options: ExecaOptions = {}): Promise<TryResult> {
  try {
    const result = await runShellQuiet(script, options);
    return { ok: true, ...result };
  } catch (error) {
    if (isCancellation(error)) throw error;
    const err = error as { stdout?: unknown; stderr?: unknown };
    return { ok: false, stdout: asString(err.stdout), stderr: asString(err.stderr) };
  }
}

function logVerbose(file: string, args: string[]): void {
  if (process.env.WP_LOCALIFY_VERBOSE === "1") {
    console.error(`$ ${file} ${args.map(quoteForLog).join(" ")}`);
  }
}

function logVerboseShell(script: string): void {
  if (process.env.WP_LOCALIFY_VERBOSE === "1") {
    console.error(`$ ${script}`);
  }
}

function quoteForLog(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
