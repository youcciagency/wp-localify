import { runQuiet } from "../exec.js";
import type { SiteConfig } from "../types.js";

interface DependencyCheck {
  name: string;
  command: string;
}

export async function checkCommand(command: string): Promise<boolean> {
  try {
    await runQuiet("command", ["-v", command], { shell: true });
    return true;
  } catch {
    return false;
  }
}

export async function checkDockerCompose(): Promise<boolean> {
  const plugin = await checkCommand("docker");
  if (!plugin) return false;
  const composeV2 = await runQuiet("docker", ["compose", "version"]).then(
    () => true,
    () => false,
  );
  if (composeV2) return true;
  return checkCommand("docker-compose");
}

function getInstallInstructions(tool: string): string {
  const platform = process.platform;
  const instructions: Record<string, Record<string, string>> = {
    docker: {
      darwin: "Install Docker Desktop from https://www.docker.com/products/docker-desktop",
      linux: "Install Docker: sudo apt-get install docker.io docker-compose-plugin",
      default: "Install Docker from https://www.docker.com/get-started",
    },
    mkcert: {
      darwin: "brew install mkcert",
      linux: "Visit https://github.com/FiloSottile/mkcert#linux",
      default: "Visit https://github.com/FiloSottile/mkcert",
    },
    rsync: {
      darwin: "Already installed on macOS",
      linux: "sudo apt-get install rsync",
      default: "Install rsync for your platform",
    },
    lftp: {
      darwin: "brew install lftp",
      linux: "sudo apt-get install lftp",
      default: "Visit https://lftp.yar.ru/",
    },
    mysqldump: {
      darwin: "brew install mysql-client",
      linux: "sudo apt-get install mysql-client",
      default: "Install MySQL client tools for your platform",
    },
    ssh: {
      darwin: "Already installed on macOS",
      linux: "sudo apt-get install openssh-client",
      default: "Install OpenSSH client",
    },
  };

  const byTool = instructions[tool] ?? {};
  return byTool[platform] ?? byTool.default ?? `Install ${tool} for your platform`;
}

export interface DependencyReport {
  success: boolean;
  missing: DependencyCheck[];
  message: string;
}

export interface DependencyCheckOptions {
  needsMkcert?: boolean;
  needsMysqldump?: boolean;
  needsRsync?: boolean;
  needsLftp?: boolean;
  needsSsh?: boolean;
}

export async function checkDependencies(
  site: Partial<Pick<SiteConfig, "downloadProtocol" | "dbAccess">> | null,
  options: DependencyCheckOptions = {},
  throwOnMissing = true,
): Promise<DependencyReport> {
  const missing: DependencyCheck[] = [];
  const checks: DependencyCheck[] = [];

  if (!(await checkCommand("docker"))) {
    missing.push({ name: "docker", command: "docker" });
  }

  if (!(await checkDockerCompose())) {
    missing.push({ name: "docker compose", command: "docker" });
  }

  if (options.needsMkcert !== false) checks.push({ name: "mkcert", command: "mkcert" });

  if (options.needsRsync || site?.downloadProtocol === "ssh") {
    checks.push({ name: "rsync", command: "rsync" });
  }
  if (options.needsLftp || site?.downloadProtocol === "ftp") {
    checks.push({ name: "lftp", command: "lftp" });
  }
  if (options.needsSsh || site?.dbAccess === "ssh-tunnel") {
    checks.push({ name: "ssh", command: "ssh" });
  }
  if (options.needsMysqldump !== false) {
    checks.push({ name: "mysqldump", command: "mysqldump" });
  }

  for (const check of checks) {
    if (!(await checkCommand(check.command))) {
      missing.push(check);
    }
  }

  if (missing.length > 0 && throwOnMissing) {
    const lines = ["Missing required dependencies:", ""];
    for (const tool of missing) {
      lines.push(`  ❌ ${tool.name}`);
      lines.push(`     Install: ${getInstallInstructions(tool.command)}`);
      lines.push("");
    }
    throw new Error(lines.join("\n"));
  }

  let message = "";
  if (missing.length > 0) {
    const lines = ["Missing required dependencies:", ""];
    for (const tool of missing) {
      lines.push(`  ❌ ${tool.name}`);
      lines.push(`     Install: ${getInstallInstructions(tool.command)}`);
      lines.push("");
    }
    message = lines.join("\n");
  }

  return { success: missing.length === 0, missing, message };
}
