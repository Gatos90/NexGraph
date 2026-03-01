#!/usr/bin/env node

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

function printUsage() {
  console.log(`\nInstall the NexGraph Claude plugin files into a project\n
Usage:
  node install.cjs --target /absolute/path/to/project [options]

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

function readOption(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function normalizeApiBaseUrl(raw) {
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

function buildHttpServerConfig(opts) {
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

function buildStdioServerConfig(opts) {
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

function buildMcpServerConfig(opts) {
  if (opts.transport === "stdio") {
    return buildStdioServerConfig(opts);
  }
  return buildHttpServerConfig(opts);
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function copyTree(srcDir, dstDir, overwrite) {
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

async function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  const raw = await fsp.readFile(filePath, "utf-8");
  return JSON.parse(raw);
}

async function writeJsonFile(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function mergeMcpConfig(targetRoot, opts) {
  const filePath = path.join(targetRoot, ".mcp.json");
  const parsed = await readJsonFile(filePath, {});

  const servers =
    parsed.mcpServers && typeof parsed.mcpServers === "object"
      ? parsed.mcpServers
      : {};

  servers[opts.serverName] = buildMcpServerConfig(opts);
  parsed.mcpServers = servers;

  await writeJsonFile(filePath, parsed);
}

function buildHookMatcherEntry() {
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

function hasNexgraphHookEntry(preToolUse) {
  for (const item of preToolUse) {
    if (!item || typeof item !== "object") continue;
    const hooks = item.hooks;
    if (!Array.isArray(hooks)) continue;

    for (const hook of hooks) {
      if (!hook || typeof hook !== "object") continue;
      const command = hook.command;
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

async function mergeHooksConfig(targetRoot) {
  const filePath = path.join(targetRoot, "hooks", "hooks.json");
  const parsed = await readJsonFile(filePath, {});

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

async function installPluginBundle(opts) {
  const targetRoot = path.resolve(opts.targetDir);
  await ensureDir(targetRoot);

  const templateRoot = __dirname;
  const copyTargets = [".claude-plugin", "hooks", "skills"];

  for (const rel of copyTargets) {
    await copyTree(
      path.join(templateRoot, rel),
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

function parseOptions(argv) {
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    printUsage();
    process.exit(0);
  }

  const transportRaw = (readOption(argv, "--transport") ?? "http").toLowerCase();
  if (transportRaw !== "http" && transportRaw !== "stdio") {
    throw new Error(`Invalid --transport value: ${transportRaw}`);
  }

  return {
    targetDir: readOption(argv, "--target") ?? process.cwd(),
    apiUrl: readOption(argv, "--api-url") ?? "http://localhost:3000",
    apiKey: readOption(argv, "--api-key"),
    serverName: readOption(argv, "--server-name") ?? "nexgraph",
    force: hasFlag(argv, "--force"),
    transport: transportRaw,
  };
}

async function main() {
  const opts = parseOptions(process.argv.slice(2));
  await installPluginBundle(opts);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
