import { CliError } from "../errors.js";
import { run } from "../exec.js";

export function assertSupportedPlatform(): void {
  if (process.platform === "win32") {
    throw new CliError("wp-localify does not support native Windows.", {
      hint: "Run it inside WSL2 (https://learn.microsoft.com/windows/wsl) with Docker Desktop's WSL integration enabled.",
    });
  }
}

export async function openInBrowser(url: string): Promise<void> {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  await run(opener, [url]);
}
