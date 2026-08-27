import { note } from "@clack/prompts";
import type { CollectedSiteStatus } from "../site/artifacts.js";
import type { Registry } from "../types.js";

export function printSiteList(registry: Registry): void {
  const keys = Object.keys(registry.sites);
  if (keys.length === 0) {
    note("No sites configured yet. Run: wp-localify site add", "Sites");
    return;
  }

  const lines = keys.map((key) => {
    const site = registry.sites[key];
    if (!site) return `  ${key}`;
    const activeMarker = registry.activeSite === key ? "*" : " ";
    return `${activeMarker} ${key.padEnd(14)} ${site.localDomain.padEnd(24)} ${site.downloadProtocol.toUpperCase()} ${site.localWpPath}`;
  });

  note(lines.join("\n"), "Sites (* = active)");
}

function boolLabel(value: boolean | "unknown"): string {
  if (value === "unknown") return "?";
  return value ? "yes" : "no";
}

export function renderStatus(
  activeSite: string | null,
  gatewayRunning: boolean,
  statuses: CollectedSiteStatus[],
): string {
  const gatewayWidth = 10;
  const keyWidth = Math.max("site".length, ...statuses.map((s) => s.key.length)) + 2;
  const domainWidth = Math.max("domain".length, ...statuses.map((s) => s.domain.length)) + 2;
  const stateWidth = 9;

  const header = `${"gateway".padEnd(gatewayWidth)}${"site".padEnd(keyWidth)}${"domain".padEnd(domainWidth)}${"state".padEnd(stateWidth)}wp-files  db-dump  hosts`;
  const separator = "-".repeat(header.length);

  const rows = statuses.map((item) => {
    const state = item.running ? "running" : item.initialized ? "stopped" : "not-init";
    return [
      "".padEnd(gatewayWidth),
      `${item.key}${activeSite === item.key ? " *" : ""}`.padEnd(keyWidth),
      item.domain.padEnd(domainWidth),
      state.padEnd(stateWidth),
      boolLabel(item.wpFiles).padEnd(9),
      boolLabel(item.dbDump).padEnd(8),
      boolLabel(item.hostsEntry),
    ].join("");
  });

  const gatewayLine = `gateway: ${gatewayRunning ? "running" : "stopped"}`;
  const details = statuses.map((item) => {
    return [
      `  ${item.key}:`,
      `    services: ${item.runningServices.length > 0 ? item.runningServices.join(", ") : "none"}`,
      `    path:     ${item.localWpPath}`,
    ].join("\n");
  });

  const body = [header, separator, ...rows].join("\n");
  if (details.length === 0) return [gatewayLine, "", "(no sites configured)"].join("\n");
  return [body, "", ...details].join("\n");
}
