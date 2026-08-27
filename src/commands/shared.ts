import type { Command } from "commander";
import { loadRegistry, saveRegistry } from "../registry/store.js";
import { requireSite } from "../registry/select.js";
import { promptSiteConfig } from "../ui/prompts.js";
import { isGatewayRunning } from "../docker/gateway.js";
import type { GatewaySettings, Registry, SiteConfig } from "../types.js";

export interface SiteActionOptions {
  site?: string;
  reconfigure?: boolean;
}

export function addSiteOptions(cmd: Command): Command {
  return cmd
    .option("--site <key>", "Site key (defaults to active site)")
    .option("--reconfigure", "Prompt and update site config first");
}

export interface LoadedSite {
  registry: Registry;
  settings: GatewaySettings;
  site: SiteConfig;
  gatewayRunning: () => Promise<boolean>;
}

/** Resolve registry + active/requested site once for any site-scoped action. */
export async function loadSiteForAction(options: SiteActionOptions): Promise<LoadedSite> {
  const registry = await loadRegistry();
  let site = await requireSite(registry, options.site);

  if (options.reconfigure) {
    site = await promptSiteConfig(site, registry, "edit");
    registry.sites[site.key] = site;
    await saveRegistry(registry);
  }

  return {
    registry,
    settings: registry.settings,
    site,
    gatewayRunning: isGatewayRunning,
  };
}
