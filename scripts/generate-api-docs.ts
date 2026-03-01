/**
 * Auto-generate API reference docs from the OpenAPI 3.1 spec.
 *
 * Usage:  tsx scripts/generate-api-docs.ts
 *
 * The script:
 *   1. Creates the Hono app (which registers all routes + OpenAPI metadata)
 *   2. Fetches /api/v1/openapi.json via app.request() — no running server needed
 *   3. Generates one Markdown page per OpenAPI tag under docs/api/
 *   4. Writes docs/api/_generated-index.md with a summary table
 */

import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Stub env vars so config.ts doesn't throw during doc generation
process.env.DATABASE_URL ??= "postgresql://localhost/nexgraph";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_API_DIR = resolve(__dirname, "..", "docs", "api");

// ---------------------------------------------------------------------------
// Types mirroring the subset of OpenAPI 3.1 we actually use
// ---------------------------------------------------------------------------

interface OpenAPISpec {
  openapi: string;
  info: { title: string; version: string; description?: string };
  paths: Record<string, Record<string, OperationObject>>;
}

interface OperationObject {
  tags?: string[];
  summary?: string;
  description?: string;
  operationId?: string;
  parameters?: ParameterObject[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: SchemaObject }>;
  };
  responses?: Record<
    string,
    {
      description?: string;
      content?: Record<string, { schema?: SchemaObject }>;
    }
  >;
}

interface ParameterObject {
  name: string;
  in: "path" | "query" | "header";
  required?: boolean;
  schema?: SchemaObject;
  description?: string;
}

interface SchemaObject {
  type?: string;
  format?: string;
  enum?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  properties?: Record<string, SchemaObject>;
  required?: string[];
  items?: SchemaObject;
  anyOf?: SchemaObject[];
  oneOf?: SchemaObject[];
  allOf?: SchemaObject[];
  description?: string;
  nullable?: boolean;
  additionalProperties?: boolean | SchemaObject;
  $ref?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function methodBadge(method: string): string {
  return method.toUpperCase();
}

/** Pretty-print a Zod-OpenAPI schema into a readable type table */
function schemaToMarkdownTable(
  schema: SchemaObject | undefined,
  indent = 0
): string {
  if (!schema) return "";
  const props = schema.properties;
  if (!props) return "";

  const req = new Set(schema.required ?? []);
  const lines: string[] = [];
  lines.push("| Field | Type | Required | Description |");
  lines.push("|-------|------|----------|-------------|");

  for (const [name, prop] of Object.entries(props)) {
    const type = resolveType(prop);
    const required = req.has(name) ? "Yes" : "No";
    const desc = buildFieldDescription(name, prop);
    const pad = "  ".repeat(indent);
    lines.push(`| ${pad}\`${name}\` | ${type} | ${required} | ${desc} |`);
  }
  return lines.join("\n");
}

function resolveType(s: SchemaObject): string {
  if (s.$ref) {
    const parts = s.$ref.split("/");
    return `\`${parts[parts.length - 1]}\``;
  }
  if (s.anyOf) {
    return s.anyOf.map(resolveType).join(" \\| ");
  }
  if (s.oneOf) {
    return s.oneOf.map(resolveType).join(" \\| ");
  }
  if (s.allOf) {
    return s.allOf.map(resolveType).join(" & ");
  }
  if (s.enum) {
    return s.enum.map((v) => `\`"${v}"\``).join(" \\| ");
  }
  if (s.type === "array" && s.items) {
    return `${resolveType(s.items)}[]`;
  }
  if (s.type === "object" && s.additionalProperties) {
    return "object";
  }
  return s.type ?? "any";
}

function buildFieldDescription(_name: string, prop: SchemaObject): string {
  const parts: string[] = [];
  if (prop.description) parts.push(prop.description);
  if (prop.default !== undefined) parts.push(`Default: \`${JSON.stringify(prop.default)}\``);
  if (prop.minimum !== undefined) parts.push(`Min: ${prop.minimum}`);
  if (prop.maximum !== undefined) parts.push(`Max: ${prop.maximum}`);
  if (prop.minLength !== undefined) parts.push(`Min length: ${prop.minLength}`);
  if (prop.maxLength !== undefined) parts.push(`Max length: ${prop.maxLength}`);
  if (prop.format) parts.push(`Format: ${prop.format}`);
  return parts.join(". ") || "—";
}

/** Build a JSON example from a schema */
function schemaToExample(schema: SchemaObject | undefined): unknown {
  if (!schema) return {};
  if (schema.anyOf) return schemaToExample(schema.anyOf[0]);
  if (schema.oneOf) return schemaToExample(schema.oneOf[0]);
  if (schema.allOf) {
    return schema.allOf.reduce(
      (acc, s) => Object.assign(acc as Record<string, unknown>, schemaToExample(s)),
      {}
    );
  }
  if (schema.enum) return schema.enum[0];
  switch (schema.type) {
    case "string":
      return exampleString(schema);
    case "number":
    case "integer":
      return schema.default ?? schema.minimum ?? 1;
    case "boolean":
      return schema.default ?? true;
    case "array":
      return schema.items ? [schemaToExample(schema.items)] : [];
    case "object": {
      if (!schema.properties) return {};
      const obj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(schema.properties)) {
        obj[k] = schemaToExample(v);
      }
      return obj;
    }
    default:
      return null;
  }
}

function exampleString(s: SchemaObject): string {
  if (s.enum) return s.enum[0];
  if (s.format === "uuid") return "550e8400-e29b-41d4-a716-446655440000";
  if (s.format === "date-time") return "2026-01-15T10:30:00.000Z";
  if (s.default) return String(s.default);
  return "string";
}

/**
 * Context-aware example overrides for specific fields.
 * Keys are "operationTag:fieldPath" or just "fieldName".
 */
const FIELD_EXAMPLES: Record<string, unknown> = {
  "name": "my-project",
  "description": "A code intelligence project",
  "label": "ci-read-only",
  "query": "MATCH (f:Function) RETURN f.name, f.file_path LIMIT 10",
  "symbol": "handleRequest",
  "file_path": "src/index.ts",
  "from": "UserService",
  "to": "DatabasePool",
  "from_file_path": "src/services/user.ts",
  "to_file_path": "src/db/pool.ts",
  "pattern": "TODO|FIXME",
  "file_pattern": "*.ts",
  "direction": "both",
  "start_symbol": "handleRequest",
  "source_node": "UserService.getUser",
  "target_node": "UserAPI.fetchUser",
  "edge_type": "CROSS_REPO_CALLS",
  "url": "https://github.com/expressjs/express.git",
  "default_branch": "main",
  "source_type": "git_url",
};

/** Override schemaToExample for fields with known good examples */
function schemaToExampleEnhanced(schema: SchemaObject | undefined): unknown {
  if (!schema) return {};
  if (schema.anyOf) return schemaToExampleEnhanced(schema.anyOf[0]);
  if (schema.oneOf) return schemaToExampleEnhanced(schema.oneOf[0]);
  if (schema.allOf) {
    return schema.allOf.reduce(
      (acc, s) => Object.assign(acc as Record<string, unknown>, schemaToExampleEnhanced(s)),
      {}
    );
  }
  if (schema.enum) return schema.enum[0];
  switch (schema.type) {
    case "string":
      return exampleString(schema);
    case "number":
    case "integer":
      return schema.default ?? schema.minimum ?? 1;
    case "boolean":
      return schema.default ?? true;
    case "array":
      return schema.items ? [schemaToExampleEnhanced(schema.items)] : [];
    case "object": {
      if (!schema.properties) return {};
      const obj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(schema.properties)) {
        // Check if we have a better example for this field name
        if (FIELD_EXAMPLES[k] !== undefined && v.type === "string" && !v.enum && !v.format) {
          obj[k] = FIELD_EXAMPLES[k];
        } else {
          obj[k] = schemaToExampleEnhanced(v);
        }
      }
      return obj;
    }
    default:
      return null;
  }
}

/** Determine if endpoint requires auth by checking if it's the public project creation */
function needsAuth(path: string, method: string): boolean {
  if (path === "/api/v1/projects" && method === "post") return false;
  if (path === "/health" && method === "get") return false;
  return true;
}

/** Build a curl example for an operation */
function buildCurlExample(
  path: string,
  method: string,
  op: OperationObject
): string {
  const url = `http://localhost:3000${path}`;
  const parts: string[] = ["curl -s"];

  if (method !== "get") {
    parts.push(`-X ${method.toUpperCase()}`);
  }

  // Replace path params with example values
  let exampleUrl = url;
  for (const param of op.parameters ?? []) {
    if (param.in === "path") {
      const example =
        param.name === "repoId" || param.name === "projectId" || param.name === "connId" || param.name === "keyId" || param.name === "jobId"
          ? "$" + param.name.toUpperCase().replace("ID", "_ID")
          : `<${param.name}>`;
      exampleUrl = exampleUrl.replace(`{${param.name}}`, example);
    }
  }

  // Query params
  const queryParams = (op.parameters ?? []).filter((p) => p.in === "query");
  if (queryParams.length > 0) {
    const qs = queryParams
      .slice(0, 2)
      .map((p) => {
        const val = p.schema?.default ?? (p.schema?.type === "number" || p.schema?.type === "integer" ? "10" : "value");
        return `${p.name}=${val}`;
      })
      .join("&");
    exampleUrl += `?${qs}`;
  }

  parts.push(`"${exampleUrl}"`);

  if (needsAuth(path, method)) {
    parts.push('-H "Authorization: Bearer $NEXGRAPH_KEY"');
  }

  // Request body
  const bodySchema =
    op.requestBody?.content?.["application/json"]?.schema;
  if (bodySchema) {
    parts.push('-H "Content-Type: application/json"');
    const example = schemaToExampleEnhanced(bodySchema);
    parts.push(`-d '${JSON.stringify(example, null, 2)}'`);
  }

  return parts.join(" \\\n  ");
}

/** Build a response example from the first successful response schema */
function buildResponseExample(op: OperationObject): {
  status: string;
  body: string | null;
} {
  const responses = op.responses ?? {};
  for (const [status, resp] of Object.entries(responses)) {
    if (status.startsWith("2")) {
      const schema = resp.content?.["application/json"]?.schema;
      if (schema) {
        const example = schemaToExampleEnhanced(schema);
        return { status, body: JSON.stringify(example, null, 2) };
      }
      return { status, body: null };
    }
  }
  return { status: "200", body: null };
}

// ---------------------------------------------------------------------------
// Tag → file slug mapping and ordering
// ---------------------------------------------------------------------------

const TAG_ORDER = [
  "System",
  "Projects",
  "API Keys",
  "Repositories",
  "Indexing",
  "Graph",
  "Search",
  "Files",
  "Connections",
  "Cross-Repo Graph",
];

function tagSlug(tag: string): string {
  return tag.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Dynamic import so env stubs are in place before config.ts loads
  const { createApp } = await import("../src/app.js");
  const app = createApp();

  // Fetch the OpenAPI spec via Hono's internal request
  const res = await app.request("/api/v1/openapi.json");
  if (!res.ok) {
    console.error("Failed to fetch OpenAPI spec:", res.status);
    process.exit(1);
  }
  const spec: OpenAPISpec = (await res.json()) as OpenAPISpec;

  console.log(
    `OpenAPI ${spec.openapi} — ${spec.info.title} v${spec.info.version}`
  );

  // Group operations by tag
  const byTag = new Map<string, { path: string; method: string; op: OperationObject }[]>();
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const tags = op.tags ?? ["Other"];
      for (const tag of tags) {
        if (!byTag.has(tag)) byTag.set(tag, []);
        byTag.get(tag)!.push({ path, method, op });
      }
    }
  }

  mkdirSync(DOCS_API_DIR, { recursive: true });

  // Generate per-tag pages
  const generatedPages: { tag: string; slug: string; count: number }[] = [];

  for (const tag of TAG_ORDER) {
    const ops = byTag.get(tag);
    if (!ops || ops.length === 0) continue;

    const slug = tagSlug(tag);
    const md = generateTagPage(tag, ops);
    const filePath = resolve(DOCS_API_DIR, `${slug}.md`);
    writeFileSync(filePath, md, "utf-8");
    console.log(`  wrote ${slug}.md (${ops.length} endpoints)`);
    generatedPages.push({ tag, slug, count: ops.length });
  }

  // Handle tags not in TAG_ORDER
  for (const [tag, ops] of byTag.entries()) {
    if (TAG_ORDER.includes(tag)) continue;
    const slug = tagSlug(tag);
    const md = generateTagPage(tag, ops);
    const filePath = resolve(DOCS_API_DIR, `${slug}.md`);
    writeFileSync(filePath, md, "utf-8");
    console.log(`  wrote ${slug}.md (${ops.length} endpoints)`);
    generatedPages.push({ tag, slug, count: ops.length });
  }

  // Append manually-documented endpoints not captured by OpenAPI
  // (plain Hono handlers using wildcard paths that @hono/zod-openapi can't express)
  appendFileContentEndpoint(resolve(DOCS_API_DIR, "files.md"));
  // Update Files count in generatedPages
  const filesPage = generatedPages.find((p) => p.tag === "Files");
  if (filesPage) filesPage.count += 1;

  // Generate overview / index page
  const indexMd = generateIndex(spec, generatedPages);
  writeFileSync(resolve(DOCS_API_DIR, "index.md"), indexMd, "utf-8");
  console.log("  wrote index.md (overview)");

  // Generate authentication page (hand-crafted content + generated examples)
  const authMd = generateAuthPage();
  writeFileSync(resolve(DOCS_API_DIR, "authentication.md"), authMd, "utf-8");
  console.log("  wrote authentication.md");

  const total = generatedPages.reduce((s, p) => s + p.count, 0);
  console.log(
    `\nDone — ${generatedPages.length} pages, ${total} endpoints documented.`
  );
}

// ---------------------------------------------------------------------------
// Manual endpoint supplements (for endpoints not expressible in OpenAPI)
// ---------------------------------------------------------------------------

function appendFileContentEndpoint(filePath: string) {
  let existing = readFileSync(filePath, "utf-8");

  // Update the endpoints list at the top
  existing = existing.replace(
    "---\n\n## `GET",
    `- [\`GET /api/v1/repositories/{repoId}/files/{filePath}\`](#get-api-v1-repositories-repoid-files-filepath) — Get file content and associated graph symbols

---

## \`GET`,
  );

  const supplement = `
## \`GET /api/v1/repositories/{repoId}/files/{filePath}\` {#get-api-v1-repositories-repoid-files-filepath}

**Get file content and associated graph symbols**

This endpoint uses a wildcard path parameter and is not part of the OpenAPI spec. It retrieves the raw source code of a file along with all symbols (functions, classes, etc.) defined in it.

::: info Authentication
Requires Bearer token. See [Authentication](./authentication).
:::

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| \`repoId\` | string (UUID) | Repository ID |
| \`filePath\` | string | Full file path within the repository (e.g., \`src/index.ts\`) |

### Response (200)

| Field | Type | Description |
|-------|------|-------------|
| \`path\` | string | File path |
| \`language\` | string \\| null | Detected language |
| \`content\` | string | Raw file content |
| \`line_count\` | number | Number of lines |
| \`symbols\` | array | Graph symbols defined in this file |
| \`symbols[].id\` | number \\| string | Graph node ID |
| \`symbols[].label\` | string | Node label (Function, Class, Interface, etc.) |
| \`symbols[].properties\` | object | Node properties (name, signature, exported, etc.) |

### Error Responses

| Status | Description |
|--------|-------------|
| \`401\` | Unauthorized |
| \`403\` | Forbidden |
| \`404\` | File or repository not found |

### Example

**Request:**

\`\`\`bash
curl -s \\
  "http://localhost:3000/api/v1/repositories/$REPO_ID/files/src/index.ts" \\
  -H "Authorization: Bearer $NEXGRAPH_KEY"
\`\`\`

**Response:**

\`\`\`json
{
  "path": "src/index.ts",
  "language": "typescript",
  "content": "import { serve } from \\"@hono/node-server\\";\\n...",
  "line_count": 42,
  "symbols": [
    {
      "id": 12345,
      "label": "Function",
      "properties": {
        "name": "startServer",
        "signature": "function startServer(): void",
        "exported": true,
        "async": true,
        "file_path": "src/index.ts",
        "start_line": 10,
        "end_line": 25
      }
    }
  ]
}
\`\`\`

---
`;

  writeFileSync(filePath, existing + supplement, "utf-8");
  console.log("  appended file content endpoint to files.md");
}

// ---------------------------------------------------------------------------
// Page generators
// ---------------------------------------------------------------------------

function generateIndex(
  spec: OpenAPISpec,
  pages: { tag: string; slug: string; count: number }[]
): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push("# Auto-generated from OpenAPI spec — do not edit by hand.");
  lines.push("# Re-generate with: npm run docs:generate");
  lines.push("---");
  lines.push("");
  lines.push("# API Reference");
  lines.push("");
  lines.push(`> ${spec.info.description}`);
  lines.push("");
  lines.push("## Base URL");
  lines.push("");
  lines.push("```");
  lines.push("http://localhost:3000/api/v1");
  lines.push("```");
  lines.push("");
  lines.push("## OpenAPI Spec");
  lines.push("");
  lines.push(
    "The live OpenAPI 3.1 specification is available at runtime:"
  );
  lines.push("");
  lines.push("```");
  lines.push("GET /api/v1/openapi.json");
  lines.push("```");
  lines.push("");
  lines.push(
    "You can import this into tools like Postman, Insomnia, or any OpenAPI-compatible client."
  );
  lines.push("");
  lines.push("## Authentication");
  lines.push("");
  lines.push(
    "Most endpoints require a Bearer token (API key). See [Authentication](./authentication) for full details."
  );
  lines.push("");
  lines.push("```http");
  lines.push("Authorization: Bearer nxg_<your-key>");
  lines.push("```");
  lines.push("");
  lines.push("## Endpoints");
  lines.push("");
  lines.push(
    "| Section | Endpoints | Description |"
  );
  lines.push("|---------|-----------|-------------|");
  const descriptions: Record<string, string> = {
    System: "Health check and system info",
    Projects: "Project CRUD — top-level organizational unit",
    "API Keys": "API key creation, listing, and revocation",
    Repositories: "Repository management and source configuration",
    Indexing: "Trigger, monitor, and cancel indexing jobs",
    Graph: "Graph queries, node/edge browsing, Cypher, impact analysis, dependencies",
    Search: "Full-text search (BM25), regex grep, cross-repo search",
    Files: "File tree browsing and file content retrieval",
    Connections: "Cross-repo connection rules and resolution",
    "Cross-Repo Graph": "Cross-repo tracing, impact analysis, statistics",
  };
  for (const page of pages) {
    const desc = descriptions[page.tag] ?? "";
    lines.push(
      `| [${page.tag}](./${page.slug}) | ${page.count} | ${desc} |`
    );
  }
  lines.push("");
  lines.push("## Error Format");
  lines.push("");
  lines.push("All error responses return JSON with a consistent shape:");
  lines.push("");
  lines.push("```json");
  lines.push(
    JSON.stringify(
      { error: "Human-readable error message" },
      null,
      2
    )
  );
  lines.push("```");
  lines.push("");
  lines.push("Common HTTP status codes:");
  lines.push("");
  lines.push("| Code | Meaning |");
  lines.push("|------|---------|");
  lines.push("| `400` | Invalid request body or parameters |");
  lines.push("| `401` | Missing or invalid API key |");
  lines.push("| `403` | Insufficient permissions or wrong project |");
  lines.push("| `404` | Resource not found |");
  lines.push("| `409` | Conflict (duplicate resource) |");
  lines.push("| `500` | Internal server error |");
  lines.push("");
  return lines.join("\n");
}

function generateAuthPage(): string {
  return `---
# Auto-generated from OpenAPI spec — do not edit by hand.
# Re-generate with: npm run docs:generate
---

# Authentication

NexGraph uses project-scoped API keys for authentication. Every API key belongs to exactly one project and can only access resources within that project.

## How It Works

1. **Create a project** — the \`POST /api/v1/projects\` endpoint is the only unauthenticated endpoint. It returns a project and an initial API key.
2. **Use the API key** — include the key as a Bearer token in the \`Authorization\` header for all subsequent requests.
3. **Project isolation** — the middleware extracts the project ID from the key and ensures you can only access your own project's resources.

## Key Format

API keys follow the format:

\`\`\`
nxg_<64 hex characters>
\`\`\`

The full key is returned **only once** at creation time. NexGraph stores a SHA-256 hash internally — there is no way to retrieve the full key later.

## Using the Key

Include the key in every request's \`Authorization\` header:

\`\`\`http
Authorization: Bearer nxg_a1b2c3d4e5f6...
\`\`\`

**Example with curl:**

\`\`\`bash
# Store the key in an environment variable
export NEXGRAPH_KEY="nxg_your_key_here"

# Use it in requests
curl -s http://localhost:3000/api/v1/repositories \\
  -H "Authorization: Bearer $NEXGRAPH_KEY" \\
  | jq .
\`\`\`

## Permissions

Each API key has a set of permissions that control what it can do:

| Permission | Allows |
|-----------|--------|
| \`read\` | List/get projects, repositories, indexing status, graph queries, search, file browsing |
| \`write\` | Create/update/delete projects, repositories, API keys; trigger indexing; manage connections |

When creating a key, specify the permissions array:

\`\`\`bash
curl -s -X POST http://localhost:3000/api/v1/projects/$PROJECT_ID/api-keys \\
  -H "Authorization: Bearer $NEXGRAPH_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "permissions": ["read"],
    "label": "ci-read-only"
  }' \\
  | jq .
\`\`\`

**Response:**

\`\`\`json
{
  "id": "e5f6a7b8-...",
  "key": "nxg_abc123def456...",
  "key_prefix": "nxg_abc1",
  "label": "ci-read-only",
  "permissions": ["read"],
  "expires_at": null,
  "created_at": "2026-01-15T10:30:00.000Z"
}
\`\`\`

::: warning
The \`key\` field is only included in the creation response. Save it immediately — you cannot retrieve it later.
:::

## Key Expiry

Keys can optionally have an \`expires_at\` timestamp (ISO 8601). Expired keys are automatically rejected by the auth middleware.

\`\`\`bash
curl -s -X POST http://localhost:3000/api/v1/projects/$PROJECT_ID/api-keys \\
  -H "Authorization: Bearer $NEXGRAPH_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "permissions": ["read", "write"],
    "label": "temp-key",
    "expires_at": "2026-06-01T00:00:00.000Z"
  }' \\
  | jq .
\`\`\`

## Revoking Keys

Revoke a key by deleting it. Revocation is a soft-delete — the record is retained for audit purposes.

\`\`\`bash
curl -s -X DELETE http://localhost:3000/api/v1/projects/$PROJECT_ID/api-keys/$KEY_ID \\
  -H "Authorization: Bearer $NEXGRAPH_KEY"
\`\`\`

## Error Responses

| Status | Cause |
|--------|-------|
| \`401 Unauthorized\` | Missing \`Authorization\` header, invalid key format, unknown key, or expired key |
| \`403 Forbidden\` | Key doesn't have the required permission, or trying to access a different project's resources |

**Example 401 response:**

\`\`\`json
{
  "error": "Invalid or expired API key"
}
\`\`\`

**Example 403 response:**

\`\`\`json
{
  "error": "Insufficient permissions: requires write"
}
\`\`\`

## Security Best Practices

- **Rotate keys regularly** — create new keys and revoke old ones
- **Use least privilege** — give CI/CD keys \`read\` only unless they need to trigger indexing
- **Set expiry dates** — for temporary access, always set \`expires_at\`
- **Never commit keys** — use environment variables or secret managers
- **One key per consumer** — makes revocation targeted and auditable
`;
}

function generateTagPage(
  tag: string,
  ops: { path: string; method: string; op: OperationObject }[]
): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push("# Auto-generated from OpenAPI spec — do not edit by hand.");
  lines.push("# Re-generate with: npm run docs:generate");
  lines.push("---");
  lines.push("");
  lines.push(`# ${tag}`);
  lines.push("");

  // Quick links
  lines.push("## Endpoints");
  lines.push("");
  for (const { path, method, op } of ops) {
    const anchor = `${method}-${path}`
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase();
    lines.push(
      `- [\`${methodBadge(method)} ${path}\`](#${anchor}) — ${op.summary ?? ""}`
    );
  }
  lines.push("");
  lines.push("---");
  lines.push("");

  // Each endpoint
  for (const { path, method, op } of ops) {
    const anchor = `${method}-${path}`
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase();

    lines.push(`## \`${methodBadge(method)} ${path}\` {#${anchor}}`);
    lines.push("");
    if (op.summary) lines.push(`**${op.summary}**`);
    if (op.description) {
      lines.push("");
      lines.push(op.description);
    }
    lines.push("");

    // Auth
    const auth = needsAuth(path, method);
    if (auth) {
      lines.push(
        "::: info Authentication\nRequires Bearer token. See [Authentication](./authentication).\n:::"
      );
    } else {
      lines.push(
        "::: tip No Authentication\nThis endpoint does not require an API key.\n:::"
      );
    }
    lines.push("");

    // Path parameters
    const pathParams = (op.parameters ?? []).filter(
      (p) => p.in === "path"
    );
    if (pathParams.length > 0) {
      lines.push("### Path Parameters");
      lines.push("");
      lines.push("| Parameter | Type | Description |");
      lines.push("|-----------|------|-------------|");
      for (const p of pathParams) {
        const type = p.schema ? resolveType(p.schema) : "string";
        lines.push(
          `| \`${p.name}\` | ${type} | ${p.description ?? "—"} |`
        );
      }
      lines.push("");
    }

    // Query parameters
    const queryParams = (op.parameters ?? []).filter(
      (p) => p.in === "query"
    );
    if (queryParams.length > 0) {
      lines.push("### Query Parameters");
      lines.push("");
      lines.push(
        "| Parameter | Type | Required | Default | Description |"
      );
      lines.push("|-----------|------|----------|---------|-------------|");
      for (const p of queryParams) {
        const type = p.schema ? resolveType(p.schema) : "string";
        const def =
          p.schema?.default !== undefined
            ? `\`${JSON.stringify(p.schema.default)}\``
            : "—";
        lines.push(
          `| \`${p.name}\` | ${type} | ${p.required ? "Yes" : "No"} | ${def} | ${p.description ?? "—"} |`
        );
      }
      lines.push("");
    }

    // Request body
    const bodySchema =
      op.requestBody?.content?.["application/json"]?.schema;
    if (bodySchema) {
      lines.push("### Request Body");
      lines.push("");
      const table = schemaToMarkdownTable(bodySchema);
      if (table) {
        lines.push(table);
        lines.push("");
      }
    }

    // Response
    const respInfo = buildResponseExample(op);
    const respSchema =
      op.responses?.[respInfo.status]?.content?.["application/json"]
        ?.schema;
    if (respSchema) {
      lines.push(`### Response (${respInfo.status})`);
      lines.push("");
      const table = schemaToMarkdownTable(respSchema);
      if (table) {
        lines.push(table);
        lines.push("");
      }
    }

    // Error responses
    const errorStatuses = Object.keys(op.responses ?? {}).filter(
      (s) => !s.startsWith("2")
    );
    if (errorStatuses.length > 0) {
      lines.push("### Error Responses");
      lines.push("");
      lines.push("| Status | Description |");
      lines.push("|--------|-------------|");
      for (const status of errorStatuses) {
        const desc = op.responses?.[status]?.description ?? "";
        lines.push(`| \`${status}\` | ${desc} |`);
      }
      lines.push("");
    }

    // Curl example
    lines.push("### Example");
    lines.push("");
    lines.push("**Request:**");
    lines.push("");
    lines.push("```bash");
    lines.push(buildCurlExample(path, method, op));
    lines.push("```");
    lines.push("");

    // Response example
    if (respInfo.body) {
      lines.push("**Response:**");
      lines.push("");
      lines.push("```json");
      lines.push(respInfo.body);
      lines.push("```");
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error("Error generating docs:", err);
  process.exit(1);
});
