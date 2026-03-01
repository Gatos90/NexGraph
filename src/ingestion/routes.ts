import { createChildLogger } from "../logger.js";

const logger = createChildLogger("routes");

// ─── Types ──────────────────────────────────────────────────

export interface DetectedRoute {
  httpMethod: string;
  urlPattern: string;
  framework: string;
  startLine: number;
  handlerName: string;
}

type RouteDetector = (
  source: string,
  lines: string[],
) => DetectedRoute[];

// ─── HTTP Method Normalization ──────────────────────────────

function normalizeMethod(method: string): string {
  return method.toUpperCase();
}

function lineNumberAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

/** Words that appear after a comma in route registrations but are not handler names. */
const HANDLER_KEYWORDS = new Set(["async", "function", "new", "await"]);

// ─── Express / Hono / Koa Router Detection (JS/TS) ─────────

const EXPRESS_METHODS = "get|post|put|delete|patch|options|head|all";

const EXPRESS_PATTERN = new RegExp(
  `(?:app|router|server|route)\\s*\\.\\s*(${EXPRESS_METHODS})\\s*\\(\\s*['\`"]([^'\`"]+)['\`"]\\s*(?:,\\s*(\\w+)(?=\\s*[,)]))?`,
  "gi",
);

const EXPRESS_GENERIC_PATTERN = new RegExp(
  `\\b([A-Za-z_$][\\w$]*)\\s*\\.\\s*(${EXPRESS_METHODS})\\s*\\(\\s*['\`"]([^'\`"]+)['\`"]\\s*(?:,\\s*([A-Za-z_$][\\w$]*)(?=\\s*[,)]))?`,
  "gi",
);

const EXPRESS_ROUTE_CHAIN_PATTERN = new RegExp(
  `\\b([A-Za-z_$][\\w$]*)\\s*\\.\\s*route\\s*\\(\\s*['\`"]([^'\`"]+)['\`"]\\s*\\)\\s*\\.\\s*(${EXPRESS_METHODS})\\s*\\(\\s*([A-Za-z_$][\\w$]*)?`,
  "gi",
);

function detectExpress(source: string): DetectedRoute[] {
  const routes: DetectedRoute[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  const pushUnique = (
    httpMethod: string,
    urlPattern: string,
    startLine: number,
    handlerName: string,
  ) => {
    const key = `${httpMethod}|${urlPattern}|${startLine}`;
    if (seen.has(key)) return;
    seen.add(key);
    routes.push({
      httpMethod,
      urlPattern,
      framework: "express",
      startLine,
      handlerName,
    });
  };

  EXPRESS_PATTERN.lastIndex = 0;

  while ((match = EXPRESS_PATTERN.exec(source)) !== null) {
    const handler = match[3] && !HANDLER_KEYWORDS.has(match[3]) ? match[3] : "";
    pushUnique(
      normalizeMethod(match[1]),
      match[2],
      lineNumberAt(source, match.index),
      handler,
    );
  }

  EXPRESS_GENERIC_PATTERN.lastIndex = 0;
  while ((match = EXPRESS_GENERIC_PATTERN.exec(source)) !== null) {
    const handler = match[4] && !HANDLER_KEYWORDS.has(match[4]) ? match[4] : "";
    pushUnique(
      normalizeMethod(match[2]),
      match[3],
      lineNumberAt(source, match.index),
      handler,
    );
  }

  EXPRESS_ROUTE_CHAIN_PATTERN.lastIndex = 0;
  while ((match = EXPRESS_ROUTE_CHAIN_PATTERN.exec(source)) !== null) {
    const handler = match[4] && !HANDLER_KEYWORDS.has(match[4]) ? match[4] : "";
    pushUnique(
      normalizeMethod(match[3]),
      match[2],
      lineNumberAt(source, match.index),
      handler,
    );
  }

  return routes;
}

// ─── NestJS Decorator Detection (TS) ────────────────────────

const NESTJS_METHODS = "Get|Post|Put|Delete|Patch|Head|Options|All";

const NESTJS_PATTERN = new RegExp(
  `@(${NESTJS_METHODS})\\s*\\(\\s*(?:['\`"]([^'\`"]*)['\`"])?\\s*\\)`,
  "g",
);

function detectNestJS(source: string): DetectedRoute[] {
  const routes: DetectedRoute[] = [];
  let match: RegExpExecArray | null;
  NESTJS_PATTERN.lastIndex = 0;

  while ((match = NESTJS_PATTERN.exec(source)) !== null) {
    // Look for the method name on the line(s) following the decorator
    const afterDecorator = source.substring(match.index + match[0].length);
    const methodMatch = afterDecorator.match(/^\s*\n?\s*(?:async\s+)?(\w+)\s*[\(<]/);
    routes.push({
      httpMethod: normalizeMethod(match[1]),
      urlPattern: match[2] ?? "/",
      framework: "nestjs",
      startLine: lineNumberAt(source, match.index),
      handlerName: methodMatch ? methodMatch[1] : "",
    });
  }

  return routes;
}

// ─── Flask Detection (Python) ───────────────────────────────

const FLASK_ROUTE_PATTERN =
  /@\w+\.route\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*methods\s*=\s*\[([^\]]*)\])?/g;

function detectFlask(source: string): DetectedRoute[] {
  const routes: DetectedRoute[] = [];
  let match: RegExpExecArray | null;
  FLASK_ROUTE_PATTERN.lastIndex = 0;

  while ((match = FLASK_ROUTE_PATTERN.exec(source)) !== null) {
    const urlPattern = match[1];
    const methodsStr = match[2];
    const startLine = lineNumberAt(source, match.index);

    // Look for `def func_name` after the decorator
    const afterDecorator = source.substring(match.index + match[0].length);
    const defMatch = afterDecorator.match(/^[^)]*\)\s*\n\s*(?:async\s+)?def\s+(\w+)/);
    const handlerName = defMatch ? defMatch[1] : "";

    if (methodsStr) {
      // Parse methods list: ['GET', 'POST']
      const methods = methodsStr
        .replace(/['"]/g, "")
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean);
      for (const method of methods) {
        routes.push({
          httpMethod: normalizeMethod(method),
          urlPattern,
          framework: "flask",
          startLine,
          handlerName,
        });
      }
    } else {
      // Default to GET when no methods specified
      routes.push({
        httpMethod: "GET",
        urlPattern,
        framework: "flask",
        startLine,
        handlerName,
      });
    }
  }

  return routes;
}

// ─── FastAPI Detection (Python) ─────────────────────────────

const FASTAPI_METHODS = "get|post|put|delete|patch|options|head";

const FASTAPI_PATTERN = new RegExp(
  `@\\w+\\.(${FASTAPI_METHODS})\\s*\\(\\s*['"]([^'"]+)['"]`,
  "gi",
);

function detectFastAPI(source: string): DetectedRoute[] {
  const routes: DetectedRoute[] = [];
  let match: RegExpExecArray | null;
  FASTAPI_PATTERN.lastIndex = 0;

  while ((match = FASTAPI_PATTERN.exec(source)) !== null) {
    // Look for `def func_name` after the decorator
    const afterDecorator = source.substring(match.index + match[0].length);
    const defMatch = afterDecorator.match(/^[^)]*\)\s*\n\s*(?:async\s+)?def\s+(\w+)/);
    routes.push({
      httpMethod: normalizeMethod(match[1]),
      urlPattern: match[2],
      framework: "fastapi",
      startLine: lineNumberAt(source, match.index),
      handlerName: defMatch ? defMatch[1] : "",
    });
  }

  return routes;
}

// ─── Go net/http Detection ──────────────────────────────────

const GO_HTTP_PATTERN =
  /http\.(HandleFunc|Handle)\s*\(\s*"([^"]+)"\s*(?:,\s*(\w+)(?=\s*[,)]))?/g;

function detectGoNetHttp(source: string): DetectedRoute[] {
  const routes: DetectedRoute[] = [];
  let match: RegExpExecArray | null;
  GO_HTTP_PATTERN.lastIndex = 0;

  while ((match = GO_HTTP_PATTERN.exec(source)) !== null) {
    routes.push({
      httpMethod: "ANY",
      urlPattern: match[2],
      framework: "go-net-http",
      startLine: lineNumberAt(source, match.index),
      handlerName: match[3] ?? "",
    });
  }

  return routes;
}

// ─── Spring Detection (Java) ────────────────────────────────

const SPRING_MAPPING_METHODS = "Get|Post|Put|Delete|Patch";

const SPRING_SPECIFIC_PATTERN = new RegExp(
  `@(${SPRING_MAPPING_METHODS})Mapping\\s*\\(\\s*(?:value\\s*=\\s*)?["']([^"']+)["']`,
  "g",
);

const SPRING_REQUEST_MAPPING_PATTERN =
  /@RequestMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["'](?:\s*,\s*method\s*=\s*RequestMethod\.(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS))?/g;

function detectSpring(source: string): DetectedRoute[] {
  const routes: DetectedRoute[] = [];
  let match: RegExpExecArray | null;

  SPRING_SPECIFIC_PATTERN.lastIndex = 0;
  while ((match = SPRING_SPECIFIC_PATTERN.exec(source)) !== null) {
    // Look for method name after annotation: public ReturnType methodName(...)
    const afterAnnotation = source.substring(match.index + match[0].length);
    const methodMatch = afterAnnotation.match(/^[^)]*\)\s*\n?\s*(?:public|private|protected)?\s*(?:\w+(?:<[^>]*>)?\s+)?(\w+)\s*\(/);
    routes.push({
      httpMethod: normalizeMethod(match[1]),
      urlPattern: match[2],
      framework: "spring",
      startLine: lineNumberAt(source, match.index),
      handlerName: methodMatch ? methodMatch[1] : "",
    });
  }

  SPRING_REQUEST_MAPPING_PATTERN.lastIndex = 0;
  while ((match = SPRING_REQUEST_MAPPING_PATTERN.exec(source)) !== null) {
    const afterAnnotation = source.substring(match.index + match[0].length);
    const methodMatch = afterAnnotation.match(/^[^)]*\)\s*\n?\s*(?:public|private|protected)?\s*(?:\w+(?:<[^>]*>)?\s+)?(\w+)\s*\(/);
    routes.push({
      httpMethod: match[2] ? normalizeMethod(match[2]) : "ANY",
      urlPattern: match[1],
      framework: "spring",
      startLine: lineNumberAt(source, match.index),
      handlerName: methodMatch ? methodMatch[1] : "",
    });
  }

  return routes;
}

// ─── Gin Detection (Go) ────────────────────────────────────

const GIN_METHODS = "GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Any|Handle";

const GIN_PATTERN = new RegExp(
  `\\w+\\.(${GIN_METHODS})\\s*\\(\\s*"([^"]+)"\\s*(?:,\\s*(\\w+)(?=\\s*[,)]))?`,
  "g",
);

function detectGin(source: string): DetectedRoute[] {
  const routes: DetectedRoute[] = [];
  let match: RegExpExecArray | null;
  GIN_PATTERN.lastIndex = 0;

  while ((match = GIN_PATTERN.exec(source)) !== null) {
    const method = match[1];
    routes.push({
      httpMethod: method === "Any" || method === "Handle" ? "ANY" : normalizeMethod(method),
      urlPattern: match[2],
      framework: "gin",
      startLine: lineNumberAt(source, match.index),
      handlerName: match[3] ?? "",
    });
  }

  return routes;
}

// ─── Rails Detection (Ruby) ────────────────────────────────

const RAILS_METHODS = "get|post|put|patch|delete|match";

const RAILS_ROUTE_PATTERN = new RegExp(
  `^\\s*(${RAILS_METHODS})\\s+['"]([^'"]+)['"](?:.*?to:\\s*['"]\\w+#(\\w+)['"])?`,
  "gm",
);

const RAILS_RESOURCES_PATTERN =
  /^\s*resources?\s+:(\w+)/gm;

function detectRails(source: string): DetectedRoute[] {
  const routes: DetectedRoute[] = [];
  let match: RegExpExecArray | null;

  RAILS_ROUTE_PATTERN.lastIndex = 0;
  while ((match = RAILS_ROUTE_PATTERN.exec(source)) !== null) {
    const method = match[1];
    routes.push({
      httpMethod: method === "match" ? "ANY" : normalizeMethod(method),
      urlPattern: match[2],
      framework: "rails",
      startLine: lineNumberAt(source, match.index),
      handlerName: match[3] ?? "",
    });
  }

  RAILS_RESOURCES_PATTERN.lastIndex = 0;
  while ((match = RAILS_RESOURCES_PATTERN.exec(source)) !== null) {
    const resource = match[1];
    const startLine = lineNumberAt(source, match.index);
    // Rails resources generate conventional REST routes
    const resourceRoutes: Array<[string, string]> = [
      ["GET", `/${resource}`],
      ["GET", `/${resource}/:id`],
      ["POST", `/${resource}`],
      ["PUT", `/${resource}/:id`],
      ["PATCH", `/${resource}/:id`],
      ["DELETE", `/${resource}/:id`],
      ["GET", `/${resource}/new`],
      ["GET", `/${resource}/:id/edit`],
    ];
    for (const [method, pattern] of resourceRoutes) {
      routes.push({
        httpMethod: method,
        urlPattern: pattern,
        framework: "rails",
        startLine,
        handlerName: "",
      });
    }
  }

  return routes;
}

// ─── Language-to-Detector Mapping ───────────────────────────

const DETECTORS_BY_LANGUAGE: Record<string, RouteDetector[]> = {
  typescript: [detectExpress, detectNestJS],
  javascript: [detectExpress],
  python: [detectFlask, detectFastAPI],
  go: [detectGoNetHttp, detectGin],
  java: [detectSpring],
  ruby: [detectRails],
};

// ─── Main Detection Function ────────────────────────────────

/**
 * Detect HTTP route handlers in a source file based on its language.
 * Returns an array of detected routes with method, URL pattern, and framework.
 */
export function detectRouteHandlers(
  source: string,
  language: string,
): DetectedRoute[] {
  const detectors = DETECTORS_BY_LANGUAGE[language];
  if (!detectors) return [];

  const lines = source.split("\n");
  const allRoutes: DetectedRoute[] = [];

  for (const detector of detectors) {
    const routes = detector(source, lines);
    allRoutes.push(...routes);
  }

  if (allRoutes.length > 0) {
    logger.debug(
      { language, routeCount: allRoutes.length },
      "Routes detected in file",
    );
  }

  return allRoutes;
}
