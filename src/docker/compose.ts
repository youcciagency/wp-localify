import path from "node:path";
import { execa, type Options as ExecaOptions, type ResultPromise } from "execa";
import { GATEWAY_COMPOSE_PATH, GATEWAY_PROJECT_NAME, GATEWAY_ROOT } from "../paths.js";
import { isAborted, asString } from "../exec.js";
import type { SiteContext } from "../types.js";

function siteBaseArgs(ctx: SiteContext): string[] {
  return ["compose", "-p", ctx.projectName, "-f", ctx.files.compose];
}

export function runSiteCompose(ctx: SiteContext, args: string[], options: ExecaOptions = {}): ResultPromise {
  return execa("docker", [...siteBaseArgs(ctx), ...args], {
    stdio: "inherit",
    cwd: ctx.dirs.docker,
    ...options,
  });
}

export interface ComposeResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export async function runSiteComposeQuiet(
  ctx: SiteContext,
  args: string[],
  options: ExecaOptions = {},
): Promise<ComposeResult> {
  try {
    const result = await execa("docker", [...siteBaseArgs(ctx), ...args], {
      cwd: ctx.dirs.docker,
      ...options,
    });
    return { ok: true, stdout: asString(result.stdout), stderr: asString(result.stderr) };
  } catch (error) {
    if (isAborted() || (error instanceof Error && error.name === "AbortError")) throw error;
    const err = error as { stdout?: unknown; stderr?: unknown };
    return { ok: false, stdout: asString(err.stdout), stderr: asString(err.stderr) };
  }
}

export function gatewayBaseArgs(): string[] {
  return ["compose", "-p", GATEWAY_PROJECT_NAME, "-f", GATEWAY_COMPOSE_PATH];
}

export function runGatewayCompose(args: string[], options: ExecaOptions = {}): ResultPromise {
  return execa("docker", [...gatewayBaseArgs(), ...args], {
    stdio: "inherit",
    cwd: GATEWAY_ROOT,
    ...options,
  });
}

export async function runGatewayComposeQuiet(
  args: string[],
  options: ExecaOptions = {},
): Promise<ComposeResult> {
  const result = await execa("docker", [...gatewayBaseArgs(), ...args], {
    cwd: GATEWAY_ROOT,
    ...options,
  });
  return { ok: true, stdout: asString(result.stdout), stderr: asString(result.stderr) };
}

export async function runGatewayComposeMaybe(
  args: string[],
  options: ExecaOptions = {},
): Promise<ComposeResult> {
  try {
    return await runGatewayComposeQuiet(args, options);
  } catch (error) {
    if (isAborted() || (error instanceof Error && error.name === "AbortError")) throw error;
    const err = error as { stdout?: unknown; stderr?: unknown };
    return { ok: false, stdout: asString(err.stdout), stderr: asString(err.stderr) };
  }
}

export function composeDir(composePath: string): string {
  return path.dirname(composePath);
}
