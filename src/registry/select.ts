import { select } from "@clack/prompts";
import { CliError, exitCancelled } from "../errors.js";
import { canPrompt } from "../ui/env.js";
import type { Registry, SiteConfig } from "../types.js";

export function resolveSite(registry: Registry, requestedKey: string | undefined): SiteConfig | null {
  if (requestedKey) {
    return registry.sites[requestedKey] ?? null;
  }

  if (registry.activeSite && registry.sites[registry.activeSite]) {
    return registry.sites[registry.activeSite] as SiteConfig;
  }

  const keys = Object.keys(registry.sites);
  if (keys.length === 1) {
    return registry.sites[keys[0] as string] as SiteConfig;
  }

  return null;
}

export async function requireSite(
  registry: Registry,
  requestedKey: string | undefined,
  promptMessage = "Select site",
): Promise<SiteConfig> {
  if (requestedKey) {
    const siteByKey = registry.sites[requestedKey];
    if (!siteByKey) {
      throw new CliError(`Unknown site '${requestedKey}'.`, {
        hint: "Run `wp-localify site list` to see configured sites.",
      });
    }
    return siteByKey;
  }

  const keys = Object.keys(registry.sites);
  if (keys.length === 0) {
    throw new CliError("No sites configured.", { hint: "Run `wp-localify site add` to create one." });
  }

  if (keys.length === 1) {
    return registry.sites[keys[0] as string] as SiteConfig;
  }

  if (!canPrompt()) {
    const list = keys.map((key) => `  - ${key}`).join("\n");
    throw new CliError(`Multiple sites are configured and no --site key was given.\n${list}`, {
      hint: "Pass --site <key>, or set the active site with `wp-localify site use <key>`.",
    });
  }

  const initialKey =
    registry.activeSite && registry.sites[registry.activeSite]
      ? (registry.activeSite as string)
      : (keys[0] as string);

  const selectedKey = await select({
    message: promptMessage,
    initialValue: initialKey,
    options: keys.map((key) => {
      const site = registry.sites[key] as SiteConfig;
      return {
        value: key,
        label: `${key} (${site.localDomain})`,
        hint: registry.activeSite === key ? "active" : site.downloadProtocol.toUpperCase(),
      };
    }),
  });

  if (typeof selectedKey === "symbol") {
    await exitCancelled();
  }

  return registry.sites[selectedKey as string] as SiteConfig;
}
