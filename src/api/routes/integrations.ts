import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { config } from "../../config.js";
import { authMiddleware, requirePermission } from "../middleware/auth.js";
import { createChildLogger } from "../../logger.js";

const logger = createChildLogger("integrations");
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

const ErrorResponse = z.object({
  error: z.string(),
});

function addDirectoryToZip(
  zip: AdmZip,
  sourceDir: string,
  zipPrefix = "",
): void {
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const absPath = path.join(sourceDir, entry.name);
    const relPath = zipPrefix ? `${zipPrefix}/${entry.name}` : entry.name;
    const normalizedRelPath = relPath.replace(/\\/g, "/");

    if (entry.isDirectory()) {
      addDirectoryToZip(zip, absPath, normalizedRelPath);
      continue;
    }

    const content = fs.readFileSync(absPath);
    zip.addFile(normalizedRelPath, content);
  }
}

function resolveTemplateRoot(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "assets", "claude-plugin"),
    path.resolve(MODULE_DIR, "../../../assets/claude-plugin"),
    path.resolve(MODULE_DIR, "../../../../assets/claude-plugin"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export const integrationRoutes = new OpenAPIHono<AppEnv>();

integrationRoutes.use(
  `${config.API_PREFIX}/integrations/*`,
  authMiddleware(),
  requirePermission("read"),
);

const claudePluginArchiveRoute = createRoute({
  method: "get",
  path: `${config.API_PREFIX}/integrations/claude-plugin/archive`,
  tags: ["Integrations"],
  summary: "Download Claude plugin bundle as zip archive",
  responses: {
    200: {
      description: "Zip archive containing .mcp-compatible plugin files",
      content: {
        "application/zip": {
          schema: z.string().openapi({ format: "binary" }),
        },
      },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponse } },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: ErrorResponse } },
    },
    500: {
      description: "Server error",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

integrationRoutes.openapi(claudePluginArchiveRoute, async (c) => {
  try {
    const templateRoot = resolveTemplateRoot();
    if (!templateRoot) {
      return c.json({ error: "Plugin template directory not found" }, 500);
    }

    const zip = new AdmZip();
    addDirectoryToZip(zip, templateRoot);
    const archive = zip.toBuffer();

    return new Response(archive, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition":
          "attachment; filename=nexgraph-claude-plugin.zip",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    logger.error({ err }, "Failed to package Claude plugin archive");
    return c.json({ error: "Failed to generate plugin archive" }, 500);
  }
});
