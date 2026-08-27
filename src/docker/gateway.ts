import { createConnection } from "node:net";
import {
  GATEWAY_CONF_DIR,
  GATEWAY_COMPOSE_PATH,
  GATEWAY_ROOT,
  MANAGED_SITES_ROOT,
  SHARED_NETWORK_NAME,
} from "../paths.js";
import { CliError } from "../errors.js";
import { run, tryRun } from "../exec.js";
import { ensureDir, readTextIfExists, atomicWriteText } from "../fsutils.js";
import { startSpinner } from "../ui/spinner.js";
import { gatewayComposeYaml } from "./templates.js";
import { runGatewayComposeMaybe, runGatewayComposeQuiet } from "./compose.js";
import type { GatewaySettings } from "../types.js";

export async function ensureDockerNetwork(): Promise<void> {
  const inspect = await tryRun("docker", ["network", "inspect", SHARED_NETWORK_NAME]);
  if (!inspect.ok) {
    await run("docker", ["network", "create", SHARED_NETWORK_NAME]);
  }
}

function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Fail early (with an actionable hint) when something other than our gateway
 * already owns the host ports. When the gateway itself is running we're done.
 */
export async function assertGatewayPortsFree(settings: GatewaySettings): Promise<void> {
  if (await isGatewayRunning()) return;

  const httpPort = settings.httpPort ?? 80;
  const httpsPort = settings.httpsPort ?? 443;

  for (const port of [httpPort, httpsPort]) {
    if (await probePort(port)) {
      throw new CliError(`Port ${port} is already in use — wp-localify cannot start its HTTPS gateway.`, {
        hint:
          `Find the process with: sudo lsof -i :${port}\n` +
          `Stop it, or change "settings.httpPort"/"settings.httpsPort" in sites.json.`,
      });
    }
  }
}

export async function isGatewayRunning(): Promise<boolean> {
  const result = await runGatewayComposeMaybe(["ps", "--services", "--status", "running"]);
  if (!result.ok) return false;
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .includes("gateway");
}

async function reloadGatewayNginx(): Promise<boolean> {
  try {
    await runGatewayComposeQuiet(["exec", "-T", "gateway", "nginx", "-s", "reload"]);
    return true;
  } catch {
    return false;
  }
}

export async function writeGatewayFiles(settings: GatewaySettings): Promise<void> {
  await ensureDir(GATEWAY_ROOT);
  await ensureDir(GATEWAY_CONF_DIR);
  const yaml = gatewayComposeYaml(settings, GATEWAY_CONF_DIR, MANAGED_SITES_ROOT);
  const current = await readTextIfExists(GATEWAY_COMPOSE_PATH);
  if (current !== yaml) {
    await atomicWriteText(GATEWAY_COMPOSE_PATH, yaml);
  }
}

/**
 * Bring up the shared gateway WITHOUT force-recreating it on every site init
 * (the old behavior briefly killed TLS for every other running site). Adding
 * a site only needs an nginx config reload now.
 */
export async function ensureGatewayInfrastructure(
  settings: GatewaySettings,
  options: { quiet?: boolean } = {},
): Promise<void> {
  await ensureDir(GATEWAY_ROOT);
  await ensureDir(GATEWAY_CONF_DIR);
  await writeGatewayFiles(settings);
  await ensureDockerNetwork();

  const running = await isGatewayRunning();

  if (!running) {
    await assertGatewayPortsFree(settings);
    const spinner = options.quiet ? undefined : startSpinner("Starting shared gateway...");
    try {
      await runGatewayComposeMaybe(["up", "-d"]);
      spinner?.stop("Gateway started.");
    } catch (error) {
      spinner?.stop("Gateway failed to start.");
      throw error;
    }
    return;
  }

  // Gateway already running: pick up conf.d changes via a zero-downtime reload.
  const reloaded = await reloadGatewayNginx();
  if (!reloaded) {
    await runGatewayComposeMaybe(["up", "-d", "--force-recreate"]);
  }
}
