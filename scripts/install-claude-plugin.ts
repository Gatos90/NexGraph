#!/usr/bin/env tsx

import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type TransportType = "http" | "stdio";

interface InstallOptions {
  targetDir: string;
  apiUrl: string;
  apiKey?: string;
  serverName: string;
  force: boolean;
  transport: TransportType;
}

interface McpJson {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

interface HooksJson {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const TEMPLATE_ROOT = path.join(REPO_ROOT, "assets", "claude-plugin");

function printUsage(): void {
  console.log(`\nInstall the NexGraph Claude plugin files into a project\n
Usage:
  npm run plugin:install -- --target /absolute/path/to/project [options]

Options:
  --target <path>       Target project directory (default: current directory)
  --api-url <url>       NexGraph API base URL (default: http://localhost:3000)
  --api-key <key>       API key used for MCP Authorization header
  --server-name <name>  MCP server name in .mcp.json (default: nexgraph)
  --transport <mode>    MCP transport: http | stdio (default: http)
  --force               Overwrite existing plugin template files
  --help                Show this help
`);
}

function readOption(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function normalizeApiBaseUrl(raw: string): string {
  const url = new URL(raw);
  const pathNoSlash = url.pathname.replace(/\/$/, "");
  const apiPath = pathNoSlash.endsWith("/mcp")
    ? pathNoSlash.slice(0, -4)
    : pathNoSlash;

  url.pathname = apiPath || "/";
  url.search = "";
  url.hash = "";

  return url.toString().replace(/\/$/, "");
}

function buildHttpServerConfig(opts: InstallOptions): Record<string, unknown> {
  const apiBase = normalizeApiBaseUrl(opts.apiUrl);
  const mcpUrl = `${apiBase}/mcp`;
  const authToken = opts.apiKey ? opts.apiKey : "${NEXGRAPH_API_KEY}";

  return {
    type: "http",
    url: mcpUrl,
    headers: {
      Authorization: `Bearer ${authToken}`,
    },
  };
}

function buildStdioServerConfig(opts: InstallOptions): Record<string, unknown> {
  const apiBase = normalizeApiBaseUrl(opts.apiUrl);
  const apiKey = opts.apiKey ? opts.apiKey : "${NEXGRAPH_API_KEY}";

  return {
    command: "npx",
    args: ["nexgraph"],
    env: {
      NEXGRAPH_API_KEY: apiKey,
      NEXGRAPH_API_URL: apiBase,
    },
  };
}

function buildMcpServerConfig(opts: InstallOptions): Record<string, unknown> {
  if (opts.transport === "stdio") {
    return buildStdioServerConfig(opts);
  }
  return buildHttpServerConfig(opts);
}

async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

async function copyTree(srcDir: string, dstDir: string, overwrite: boolean): Promise<void> {
  await ensureDir(dstDir);
  const entries = await fsp.readdir(srcDir, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);

    if (entry.isDirectory()) {
      await copyTree(srcPath, dstPath, overwrite);
      continue;
    }

    const exists = fs.existsSync(dstPath);
    if (exists && !overwrite) {
      continue;
    }

    await ensureDir(path.dirname(dstPath));
    await fsp.copyFile(srcPath, dstPath);

    if (entry.name.endsWith(".js") && srcDir.includes(`${path.sep}hooks`)) {
      await fsp.chmod(dstPath, 0o755);
    }
  }
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  if (!fs.existsSync(filePath)) return fallback;
  const raw = await fsp.readFile(filePath, "utf-8");
  return JSON.parse(raw) as T;
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function mergeMcpConfig(targetRoot: string, opts: InstallOptions): Promise<void> {
  const filePath = path.join(targetRoot, ".mcp.json");
  const parsed = await readJsonFile<McpJson>(filePath, {});

  const servers =
    parsed.mcpServers && typeof parsed.mcpServers === "object"
      ? parsed.mcpServers
      : {};

  servers[opts.serverName] = buildMcpServerConfig(opts);
  parsed.mcpServers = servers;

  await writeJsonFile(filePath, parsed);
}

function buildHookMatcherEntry(): Record<string, unknown> {
  return {
    matcher: "Grep|Glob|Bash",
    hooks: [
      {
        type: "command",
        command: "node ${CLAUDE_PLUGIN_ROOT}/hooks/nexgraph-hook.js",
        timeout: 10,
        statusMessage: "Enriching with NexGraph context...",
      },
    ],
  };
}

function hasNexgraphHookEntry(preToolUse: unknown[]): boolean {
  for (const item of preToolUse) {
    if (!item || typeof item !== "object") continue;
    const hooks = (item as { hooks?: unknown }).hooks;
    if (!Array.isArray(hooks)) continue;

    for (const hook of hooks) {
      if (!hook || typeof hook !== "object") continue;
      const command = (hook as { command?: unknown }).command;
      if (
        typeof command === "string" &&
        command.includes("hooks/nexgraph-hook.js")
      ) {
        return true;
      }
    }
  }
  return false;
}

async function mergeHooksConfig(targetRoot: string): Promise<void> {
  const filePath = path.join(targetRoot, "hooks", "hooks.json");
  const parsed = await readJsonFile<HooksJson>(filePath, {});

  const hooksRoot =
    parsed.hooks && typeof parsed.hooks === "object"
      ? parsed.hooks
      : {};

  const preToolUse = Array.isArray(hooksRoot.PreToolUse)
    ? hooksRoot.PreToolUse
    : [];

  if (!hasNexgraphHookEntry(preToolUse)) {
    preToolUse.push(buildHookMatcherEntry());
  }

  hooksRoot.PreToolUse = preToolUse;
  parsed.hooks = hooksRoot;

  await writeJsonFile(filePath, parsed);
}

async function installPluginBundle(opts: InstallOptions): Promise<void> {
  const targetRoot = path.resolve(opts.targetDir);
  await ensureDir(targetRoot);

  if (!fs.existsSync(TEMPLATE_ROOT)) {
    throw new Error(`Plugin template not found at ${TEMPLATE_ROOT}`);
  }

  const copyTargets = [".claude-plugin", "hooks", "skills"];
  for (const rel of copyTargets) {
    await copyTree(
      path.join(TEMPLATE_ROOT, rel),
      path.join(targetRoot, rel),
      opts.force,
    );
  }

  await mergeMcpConfig(targetRoot, opts);
  await mergeHooksConfig(targetRoot);

  console.log("NexGraph Claude plugin installed.");
  console.log(`Target: ${targetRoot}`);
  console.log(`MCP transport: ${opts.transport}`);
  console.log(`MCP server name: ${opts.serverName}`);
  if (!opts.apiKey) {
    console.log("API key: using ${NEXGRAPH_API_KEY} placeholder in .mcp.json");
  }
}

function parseOptions(argv: string[]): InstallOptions {
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    printUsage();
    process.exit(0);
  }

  const transportRaw = (readOption(argv, "--transport") ?? "http").toLowerCase();
  if (transportRaw !== "http" && transportRaw !== "stdio") {
    throw new Error(`Invalid --transport value: ${transportRaw}`);
  }

  const targetDir = readOption(argv, "--target") ?? process.cwd();
  const apiUrl =
    readOption(argv, "--api-url") ??
    process.env.NEXGRAPH_API_URL ??
    "http://localhost:3000";

  const apiKey = readOption(argv, "--api-key") ?? process.env.NEXGRAPH_API_KEY;
  const serverName = readOption(argv, "--server-name") ?? "nexgraph";
  const force = hasFlag(argv, "--force");

  return {
    targetDir,
    apiUrl,
    apiKey,
    serverName,
    force,
    transport: transportRaw,
  };
}

async function main(): Promise<void> {
  const opts = parseOptions(process.argv.slice(2));
  await installPluginBundle(opts);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Failed to install NexGraph Claude plugin: ${message}`);
  process.exit(1);
});
