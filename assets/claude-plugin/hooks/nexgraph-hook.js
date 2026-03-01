#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const SERVER_NAME = "nexgraph";
const MAX_REPO_SCAN_DEPTH = 8;
const MAX_CONTEXT_RESULTS = 5;

function readInput() {
  try {
    const raw = fs.readFileSync(0, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function findMcpConfig(startDir) {
  let current = startDir;
  for (let i = 0; i < MAX_REPO_SCAN_DEPTH; i += 1) {
    const candidate = path.join(current, ".mcp.json");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

function resolveTemplateVariable(raw) {
  if (typeof raw !== "string") return undefined;
  const match = raw.match(/^\$\{([A-Z0-9_]+)\}$/);
  if (!match) return undefined;
  const value = process.env[match[1]];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resolveBearerToken(raw) {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return undefined;
  const token = trimmed.slice(7).trim();

  if (/^\$\{[A-Z0-9_]+\}$/.test(token)) {
    return resolveTemplateVariable(token);
  }

  return token.length > 0 ? token : undefined;
}

function deriveApiBaseFromMcpUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0) return undefined;

  let value = raw;
  if (/^\$\{[A-Z0-9_]+\}$/.test(value)) {
    const resolved = resolveTemplateVariable(value);
    if (!resolved) return undefined;
    value = resolved;
  }

  try {
    const url = new URL(value);
    const normalizedPath = url.pathname.replace(/\/$/, "");
    const apiPath = normalizedPath.endsWith("/mcp")
      ? normalizedPath.slice(0, -4)
      : normalizedPath;

    url.pathname = apiPath || "/";
    url.search = "";
    url.hash = "";

    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function loadConnectionFromMcpConfig(cwd) {
  const mcpPath = findMcpConfig(cwd);
  if (!mcpPath) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(mcpPath, "utf-8"));
    const server = parsed?.mcpServers?.[SERVER_NAME];
    if (!server || typeof server !== "object") return null;

    const apiUrl = deriveApiBaseFromMcpUrl(server.url);
    const authHeader = server?.headers?.Authorization ?? server?.headers?.authorization;
    const apiKey = resolveBearerToken(authHeader);

    if (!apiUrl || !apiKey) return null;
    return { apiUrl, apiKey };
  } catch {
    return null;
  }
}

function loadConnection(cwd) {
  const fromConfig = loadConnectionFromMcpConfig(cwd);
  if (fromConfig) return fromConfig;

  const envApiKey = process.env.NEXGRAPH_API_KEY;
  const envApiUrl = process.env.NEXGRAPH_API_URL;

  if (typeof envApiKey === "string" && envApiKey.length > 0 && typeof envApiUrl === "string" && envApiUrl.length > 0) {
    const normalized = deriveApiBaseFromMcpUrl(envApiUrl);
    if (normalized) {
      return { apiUrl: normalized, apiKey: envApiKey };
    }
  }

  return null;
}

function extractPattern(toolName, toolInput) {
  if (toolName === "Grep") {
    return typeof toolInput.pattern === "string" ? toolInput.pattern.trim() : null;
  }

  if (toolName === "Glob") {
    const raw = typeof toolInput.pattern === "string" ? toolInput.pattern : "";
    const match = raw.match(/[A-Za-z][A-Za-z0-9_-]{2,}/);
    return match ? match[0] : null;
  }

  if (toolName === "Bash") {
    const cmd = typeof toolInput.command === "string" ? toolInput.command : "";
    if (!/\brg\b|\bgrep\b/.test(cmd)) return null;

    const parts = cmd.split(/\s+/);
    let seenSearchCmd = false;
    let skipNext = false;

    const flagsWithValue = new Set([
      "-e",
      "-f",
      "-g",
      "--glob",
      "-t",
      "--type",
      "--include",
      "--exclude",
      "-A",
      "-B",
      "-C",
      "-m",
    ]);

    for (const part of parts) {
      if (skipNext) {
        skipNext = false;
        continue;
      }

      if (!seenSearchCmd) {
        if (part === "rg" || part === "grep") {
          seenSearchCmd = true;
        }
        continue;
      }

      if (part.startsWith("-")) {
        if (flagsWithValue.has(part)) {
          skipNext = true;
        }
        continue;
      }

      const cleaned = part.replace(/["']/g, "").trim();
      if (cleaned.length >= 3) {
        return cleaned;
      }
    }
  }

  return null;
}

async function requestJson(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);

  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function selectRepository(repositories, cwd) {
  if (!Array.isArray(repositories) || repositories.length === 0) return null;

  const cwdBase = path.basename(cwd).toLowerCase();
  const exact = repositories.find((r) => String(r.name ?? "").toLowerCase() === cwdBase);
  if (exact) return exact;

  const partial = repositories.find((r) => cwdBase.includes(String(r.name ?? "").toLowerCase()));
  if (partial) return partial;

  return repositories[0];
}

function formatContext(pattern, repository, searchResult) {
  const lines = [`NexGraph context for \"${pattern}\"`];
  lines.push(`Repository: ${repository.name ?? repository.id}`);

  const results = Array.isArray(searchResult?.results) ? searchResult.results : [];
  if (results.length === 0) {
    lines.push("No semantic/keyword hits found.");
    return lines.join("\n");
  }

  lines.push("Top hits:");
  for (let i = 0; i < Math.min(results.length, MAX_CONTEXT_RESULTS); i += 1) {
    const item = results[i] ?? {};
    const filePath = String(item.file_path ?? "<unknown>");
    const label = item.label ? ` (${item.label})` : "";
    const symbol = item.symbol_name ? ` :: ${item.symbol_name}` : "";
    const highlight = typeof item.highlights === "string" ? item.highlights.replace(/\s+/g, " ").trim() : "";
    lines.push(`${i + 1}. ${filePath}${symbol}${label}`);
    if (highlight.length > 0) {
      lines.push(`   ${highlight.slice(0, 220)}`);
    }
  }

  return lines.join("\n");
}

async function main() {
  const input = readInput();
  if (input?.hook_event_name !== "PreToolUse") return;

  const toolName = input?.tool_name;
  if (!["Grep", "Glob", "Bash"].includes(toolName)) return;

  const pattern = extractPattern(toolName, input?.tool_input ?? {});
  if (!pattern || pattern.length < 3) return;

  const cwd = typeof input?.cwd === "string" ? input.cwd : process.cwd();
  const connection = loadConnection(cwd);
  if (!connection) return;

  const authHeaders = {
    Authorization: `Bearer ${connection.apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const reposResponse = await requestJson(`${connection.apiUrl}/api/v1/repositories`, {
    headers: authHeaders,
    timeoutMs: 7000,
  });
  const repositories = reposResponse?.repositories;
  const repository = selectRepository(repositories, cwd);
  if (!repository || !repository.id) return;

  const body = JSON.stringify({
    query: pattern,
    limit: MAX_CONTEXT_RESULTS,
    mode: "hybrid",
  });

  const searchResponse = await requestJson(
    `${connection.apiUrl}/api/v1/repositories/${repository.id}/search`,
    {
      method: "POST",
      headers: authHeaders,
      body,
      timeoutMs: 9000,
    },
  );

  const additionalContext = formatContext(pattern, repository, searchResponse);
  if (!additionalContext || additionalContext.length === 0) return;

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext,
      },
    }),
  );
}

main().catch(() => {
  // Best-effort hook: never fail the host tool execution.
});
