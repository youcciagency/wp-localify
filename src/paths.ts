import path from "node:path";
import { homedir } from "node:os";

function resolveBaseHome(): string {
  const override = process.env.WP_LOCALIFY_HOME;
  if (override && override.trim().length > 0) {
    return path.resolve(override.trim());
  }
  return path.join(homedir(), "wp-localify");
}

export const BASE_HOME = resolveBaseHome();
export const LEGACY_CONFIG_PATH = path.join(BASE_HOME, ".wp-localize.json");
export const REGISTRY_PATH = path.join(BASE_HOME, "sites.json");
export const MANAGED_SITES_ROOT = path.join(BASE_HOME, "sites");

export const GATEWAY_ROOT = path.join(BASE_HOME, "gateway");
export const GATEWAY_CONF_DIR = path.join(GATEWAY_ROOT, "conf.d");
export const GATEWAY_COMPOSE_PATH = path.join(GATEWAY_ROOT, "docker-compose.yml");

export const SHARED_NETWORK_NAME = "wp-localify-net";
export const GATEWAY_PROJECT_NAME = "wp_localify_gateway";

export const KEYCHAIN_SERVICE = "wp-localify";
