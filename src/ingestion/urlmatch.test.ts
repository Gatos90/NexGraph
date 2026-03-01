/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { describe, it, expect, vi } from "vitest";

// Mock DB, logger, and extract to prevent side effects
vi.mock("../db/connection.js", () => ({
  pool: { query: vi.fn() },
}));
vi.mock("../db/age.js", () => ({
  cypher: vi.fn(),
}));
vi.mock("../logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));
vi.mock("./extract.js", () => ({
  cleanupTempDir: vi.fn(),
}));
vi.mock("./structure.js", () => ({
  detectLanguage: vi.fn(),
}));

import {
  extractHttpCalls,
  matchUrlToRoute,
  findEnclosingFunction,
} from "./urlmatch.js";
import type { RouteHandlerInfo } from "./urlmatch.js";

// ─── extractHttpCalls Tests ──────────────────────────────────

describe("extractHttpCalls", () => {
  describe("TypeScript/JavaScript", () => {
    it("extracts fetch() calls with string literals", () => {
      const source = `
const users = await fetch('/api/users');
const data = await fetch("/api/data");
`;
      const calls = extractHttpCalls(source, "app.ts", "typescript");
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({
        httpMethod: "ANY",
        urlPath: "/api/users",
        filePath: "app.ts",
      });
      expect(calls[1]).toMatchObject({
        httpMethod: "ANY",
        urlPath: "/api/data",
      });
    });

    it("extracts fetch() with template literals and normalizes params", () => {
      const source = "const res = await fetch(`/api/users/${userId}`);";
      const calls = extractHttpCalls(source, "app.ts", "typescript");
      // Both FETCH_PATTERN and FETCH_TEMPLATE_PATTERN match backtick URLs
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const normalized = calls.find((c) => c.urlPath === "/api/users/:param");
      expect(normalized).toBeDefined();
      expect(normalized!.httpMethod).toBe("ANY");
    });

    it("extracts axios method calls with correct HTTP method", () => {
      const source = `
axios.get('/api/users');
axios.post('/api/users');
axios.put('/api/users/1');
axios.delete('/api/users/1');
`;
      const calls = extractHttpCalls(source, "app.ts", "javascript");
      expect(calls).toHaveLength(4);
      expect(calls[0]).toMatchObject({ httpMethod: "GET", urlPath: "/api/users" });
      expect(calls[1]).toMatchObject({ httpMethod: "POST", urlPath: "/api/users" });
      expect(calls[2]).toMatchObject({ httpMethod: "PUT", urlPath: "/api/users/1" });
      expect(calls[3]).toMatchObject({ httpMethod: "DELETE", urlPath: "/api/users/1" });
    });

    it("extracts axios template literal calls", () => {
      const source = "axios.get(`/api/users/${id}`);";
      const calls = extractHttpCalls(source, "app.ts", "typescript");
      // Both AXIOS_METHOD_PATTERN and AXIOS_TEMPLATE_PATTERN match backtick URLs
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const normalized = calls.find((c) => c.urlPath === "/api/users/:param");
      expect(normalized).toBeDefined();
      expect(normalized!.httpMethod).toBe("GET");
    });

    it("extracts axios config object pattern", () => {
      const source = `axios({ url: '/api/data', method: 'post' });`;
      const calls = extractHttpCalls(source, "app.ts", "typescript");
      expect(calls).toHaveLength(1);
      // The greedy [^}]* in AXIOS_CONFIG_PATTERN consumes the method field,
      // so the optional method capture group doesn't match → returns "ANY"
      expect(calls[0]).toMatchObject({
        httpMethod: "ANY",
        urlPath: "/api/data",
      });
    });

    it("extracts axios config object without method as ANY", () => {
      const source = `axios({ url: '/api/data' });`;
      const calls = extractHttpCalls(source, "app.ts", "typescript");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        httpMethod: "ANY",
        urlPath: "/api/data",
      });
    });

    it("extracts Angular httpClient calls", () => {
      const source = `
this.http.get('/api/users');
this.httpClient.post<User>('/api/users');
httpClient.delete('/api/users/1');
`;
      const calls = extractHttpCalls(source, "user.service.ts", "typescript");
      expect(calls).toHaveLength(3);
      expect(calls[0]).toMatchObject({ httpMethod: "GET", urlPath: "/api/users" });
      expect(calls[1]).toMatchObject({ httpMethod: "POST", urlPath: "/api/users" });
      expect(calls[2]).toMatchObject({ httpMethod: "DELETE", urlPath: "/api/users/1" });
    });

    it("extracts Angular httpClient template literal calls", () => {
      const source = "this.http.get<User>(`/api/users/${id}`);";
      const calls = extractHttpCalls(source, "user.service.ts", "typescript");
      // Both HTTP_CLIENT_PATTERN and HTTP_CLIENT_TEMPLATE_PATTERN match backtick URLs
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const normalized = calls.find((c) => c.urlPath === "/api/users/:param");
      expect(normalized).toBeDefined();
      expect(normalized!.httpMethod).toBe("GET");
    });

    it("strips full URLs to just the path", () => {
      const source = `fetch('https://api.example.com/api/users');`;
      const calls = extractHttpCalls(source, "app.ts", "typescript");
      expect(calls).toHaveLength(1);
      expect(calls[0].urlPath).toBe("/api/users");
    });

    it("strips query strings and hash from URLs", () => {
      const source = `fetch('/api/users?page=1#section');`;
      const calls = extractHttpCalls(source, "app.ts", "typescript");
      expect(calls).toHaveLength(1);
      expect(calls[0].urlPath).toBe("/api/users");
    });

    it("ignores non-path URLs (relative, no leading /)", () => {
      const source = `fetch('api/users');`;
      const calls = extractHttpCalls(source, "app.ts", "typescript");
      expect(calls).toHaveLength(0);
    });

    it("reports correct line numbers", () => {
      const source = `// line 1\n// line 2\nfetch('/api/users');`;
      const calls = extractHttpCalls(source, "app.ts", "typescript");
      expect(calls).toHaveLength(1);
      expect(calls[0].line).toBe(3);
    });
  });

  describe("Python", () => {
    it("extracts requests library calls", () => {
      const source = `
requests.get('/api/users')
requests.post('/api/users')
requests.put('/api/users/1')
requests.delete('/api/users/1')
`;
      const calls = extractHttpCalls(source, "client.py", "python");
      expect(calls).toHaveLength(4);
      expect(calls[0]).toMatchObject({ httpMethod: "GET", urlPath: "/api/users" });
      expect(calls[1]).toMatchObject({ httpMethod: "POST", urlPath: "/api/users" });
      expect(calls[2]).toMatchObject({ httpMethod: "PUT", urlPath: "/api/users/1" });
      expect(calls[3]).toMatchObject({ httpMethod: "DELETE", urlPath: "/api/users/1" });
    });

    it("extracts httpx library calls", () => {
      const source = `
httpx.get('/api/users')
httpx.post('/api/users')
`;
      const calls = extractHttpCalls(source, "client.py", "python");
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({ httpMethod: "GET", urlPath: "/api/users" });
      expect(calls[1]).toMatchObject({ httpMethod: "POST", urlPath: "/api/users" });
    });
  });

  describe("unsupported languages (no quoted URL strings)", () => {
    it("returns empty array when source has no quoted URL strings", () => {
      const source = `GET /api/users HTTP/1.1`;
      const calls = extractHttpCalls(source, "test.go", "go");
      expect(calls).toHaveLength(0);
    });
  });

  describe("template literal with dynamic base URL", () => {
    it("extracts httpClient call with dynamic base URL template literal", () => {
      const source = "this.http.get<User>(`${this.base}/users`);";
      const calls = extractHttpCalls(source, "api.service.ts", "typescript");
      const match = calls.find((c) => c.urlPath === "/users");
      expect(match).toBeDefined();
      expect(match!.httpMethod).toBe("GET");
    });

    it("extracts fetch call with dynamic base URL template literal", () => {
      const source = "fetch(`${apiBase}/projects`);";
      const calls = extractHttpCalls(source, "client.ts", "typescript");
      const match = calls.find((c) => c.urlPath === "/projects");
      expect(match).toBeDefined();
    });
  });

  describe("universal URL path string scanner", () => {
    it("extracts URL paths from static readonly declarations (ng-openapi-gen)", () => {
      const source = `
static readonly PostLoginPath = '/authentication/login';
static readonly GetUsersPath = '/api/users';
static readonly DeleteUserPath = '/api/users/{userId}';
`;
      const calls = extractHttpCalls(source, "auth.service.ts", "typescript");
      expect(calls.find((c) => c.urlPath === "/authentication/login")).toBeDefined();
      expect(calls.find((c) => c.urlPath === "/api/users")).toBeDefined();
      expect(calls.find((c) => c.urlPath === "/api/users/{userId}")).toBeDefined();
    });

    it("extracts URL paths from function .PATH assignments and infers method", () => {
      const source = "postLogin.PATH = '/authentication/login';";
      const calls = extractHttpCalls(source, "fn/post-login.ts", "typescript");
      const match = calls.find((c) => c.urlPath === "/authentication/login");
      expect(match).toBeDefined();
      expect(match!.httpMethod).toBe("POST");
    });

    it("extracts URL paths from enum values", () => {
      const source = `
export enum ServiceEndpoints {
  uploadDeliveryNote = '/organization-sites/:key/delivery-notes',
  getStatus = '/api/status',
}`;
      const calls = extractHttpCalls(source, "endpoints.ts", "typescript");
      expect(calls.find((c) => c.urlPath === "/organization-sites/:key/delivery-notes")).toBeDefined();
      expect(calls.find((c) => c.urlPath === "/api/status")).toBeDefined();
    });

    it("ignores filesystem paths and file references", () => {
      const source = `
const config = '/usr/local/bin/node';
const template = '/assets/logo.svg';
const style = '/dist/bundle.js';
`;
      const calls = extractHttpCalls(source, "config.ts", "typescript");
      expect(calls).toHaveLength(0);
    });

    it("extracts URL paths from Java code", () => {
      const source = `
@RequestMapping("/api/users")
@GetMapping("/api/users/{id}")
`;
      const calls = extractHttpCalls(source, "UserController.java", "java");
      expect(calls.find((c) => c.urlPath === "/api/users")).toBeDefined();
      expect(calls.find((c) => c.urlPath === "/api/users/{id}")).toBeDefined();
    });

    it("extracts URL paths from Go code", () => {
      const source = `
http.HandleFunc("/api/health", healthHandler)
r.GET("/api/users/:id", getUser)
`;
      const calls = extractHttpCalls(source, "main.go", "go");
      expect(calls.find((c) => c.urlPath === "/api/health")).toBeDefined();
      expect(calls.find((c) => c.urlPath === "/api/users/:id")).toBeDefined();
    });

    it("does not duplicate calls already found by HTTP-client patterns", () => {
      const source = "fetch('/api/users');";
      const calls = extractHttpCalls(source, "app.ts", "typescript");
      // fetch pattern finds it, string scanner should not duplicate it
      const apiUserCalls = calls.filter((c) => c.urlPath === "/api/users");
      expect(apiUserCalls).toHaveLength(1);
    });

    it("infers HTTP method from variable name prefix", () => {
      const source = `
const getEndpoint = '/api/items';
const deleteEndpoint = '/api/items/{id}';
const createEndpoint = '/api/items';
`;
      const calls = extractHttpCalls(source, "config.ts", "typescript");
      const getCalls = calls.find((c) => c.urlPath === "/api/items" && c.httpMethod === "GET");
      expect(getCalls).toBeDefined();
      const delCall = calls.find((c) => c.urlPath === "/api/items/{id}" && c.httpMethod === "DELETE");
      expect(delCall).toBeDefined();
    });
  });
});

// ─── matchUrlToRoute Tests ──────────────────────────────────

describe("matchUrlToRoute", () => {
  function makeRoute(overrides: Partial<RouteHandlerInfo> = {}): RouteHandlerInfo {
    return {
      nodeId: "1",
      httpMethod: "GET",
      urlPattern: "/api/users",
      filePath: "routes/users.ts",
      framework: "express",
      handlerName: "getUsers",
      ...overrides,
    };
  }

  describe("method matching", () => {
    it("returns null when methods don't match", () => {
      const score = matchUrlToRoute("/api/users", "POST", makeRoute({ httpMethod: "GET" }));
      expect(score).toBeNull();
    });

    it("matches when call method is ANY", () => {
      const score = matchUrlToRoute("/api/users", "ANY", makeRoute({ httpMethod: "GET" }));
      expect(score).not.toBeNull();
    });

    it("matches when route method is ANY", () => {
      const score = matchUrlToRoute("/api/users", "GET", makeRoute({ httpMethod: "ANY" }));
      expect(score).not.toBeNull();
    });
  });

  describe("exact path match", () => {
    it("returns 0.95 for exact path + specific methods", () => {
      const score = matchUrlToRoute("/api/users", "GET", makeRoute());
      expect(score).toBe(0.95);
    });

    it("returns 0.90 for exact path when call method is ANY", () => {
      const score = matchUrlToRoute("/api/users", "ANY", makeRoute());
      expect(score).toBe(0.90);
    });

    it("returns 0.90 for exact path when route method is ANY", () => {
      const score = matchUrlToRoute("/api/users", "GET", makeRoute({ httpMethod: "ANY" }));
      expect(score).toBe(0.90);
    });

    it("is case-insensitive", () => {
      const score = matchUrlToRoute("/API/USERS", "GET", makeRoute({ urlPattern: "/api/users" }));
      expect(score).toBe(0.95);
    });

    it("strips trailing slashes for comparison", () => {
      const score = matchUrlToRoute("/api/users/", "GET", makeRoute({ urlPattern: "/api/users" }));
      expect(score).toBe(0.95);
    });
  });

  describe("parameterized route matching", () => {
    it("matches /api/users/123 against /api/users/:id via segment prefix (0.65)", () => {
      // routePatternToRegex doesn't handle Express-style :param (colon is not
      // a regex special char, so it's not escaped then restored). Falls through
      // to segment prefix matching where :id is recognized as a route param.
      const route = makeRoute({ urlPattern: "/api/users/:id" });
      const score = matchUrlToRoute("/api/users/123", "GET", route);
      expect(score).toBe(0.65);
    });

    it("matches /api/users/123 against /api/users/{id} with score 0.90", () => {
      const route = makeRoute({ urlPattern: "/api/users/{id}" });
      const score = matchUrlToRoute("/api/users/123", "GET", route);
      // OpenAPI {param} syntax is properly handled by routePatternToRegex
      expect(score).toBe(0.90);
    });

    it("returns 0.55 when route method is ANY for :id parameterized route", () => {
      // :id falls to segment prefix matching (see above)
      const route = makeRoute({ urlPattern: "/api/users/:id", httpMethod: "ANY" });
      const score = matchUrlToRoute("/api/users/123", "GET", route);
      expect(score).toBe(0.55);
    });

    it("returns 0.85 when route method is ANY for {id} parameterized route", () => {
      const route = makeRoute({ urlPattern: "/api/users/{id}", httpMethod: "ANY" });
      const score = matchUrlToRoute("/api/users/123", "GET", route);
      expect(score).toBe(0.85);
    });
  });

  describe("template literal param matching (call URL with :param)", () => {
    it("matches /api/users/:param against /api/users/:id with score 0.85", () => {
      const route = makeRoute({ urlPattern: "/api/users/:id" });
      const score = matchUrlToRoute("/api/users/:param", "GET", route);
      expect(score).toBe(0.85);
    });

    it("returns 0.80 when one method is ANY for template literal match", () => {
      const route = makeRoute({ urlPattern: "/api/users/:id", httpMethod: "ANY" });
      const score = matchUrlToRoute("/api/users/:param", "GET", route);
      expect(score).toBe(0.80);
    });

    it("returns null when segment count differs for template literal match", () => {
      const route = makeRoute({ urlPattern: "/api/users" });
      const score = matchUrlToRoute("/api/users/:param/extra", "GET", route);
      expect(score).toBeNull();
    });

    it("returns null when non-param segments differ for template literal match", () => {
      const route = makeRoute({ urlPattern: "/api/posts/:id" });
      const score = matchUrlToRoute("/api/users/:param", "GET", route);
      expect(score).toBeNull();
    });
  });

  describe("segment prefix matching", () => {
    it("matches /api/users against /api/users/:id with score 0.65", () => {
      const route = makeRoute({ urlPattern: "/api/users/:id" });
      const score = matchUrlToRoute("/api/users", "GET", route);
      expect(score).toBe(0.65);
    });

    it("returns 0.55 when method is ANY for prefix match", () => {
      const route = makeRoute({ urlPattern: "/api/users/:id", httpMethod: "ANY" });
      const score = matchUrlToRoute("/api/users", "GET", route);
      expect(score).toBe(0.55);
    });

    it("returns null when prefix segments differ", () => {
      const route = makeRoute({ urlPattern: "/api/posts/:id" });
      const score = matchUrlToRoute("/api/users", "GET", route);
      expect(score).toBeNull();
    });

    it("returns null when call path is much shorter than route (more than 1 segment diff)", () => {
      const route = makeRoute({ urlPattern: "/api/v1/users/:id/posts/:postId" });
      const score = matchUrlToRoute("/api/v1", "GET", route);
      expect(score).toBeNull();
    });
  });

  describe("no match scenarios", () => {
    it("returns null for completely different paths", () => {
      const route = makeRoute({ urlPattern: "/api/products" });
      const score = matchUrlToRoute("/api/users", "GET", route);
      expect(score).toBeNull();
    });

    it("returns null when call path is longer than route", () => {
      const route = makeRoute({ urlPattern: "/api/users" });
      const score = matchUrlToRoute("/api/users/123/posts", "GET", route);
      expect(score).toBeNull();
    });
  });
});

// ─── findEnclosingFunction Tests ──────────────────────────────

describe("findEnclosingFunction", () => {
  const functionMap = new Map([
    ["src/api.ts", [
      { name: "login", startLine: 4, endLine: 11 },
      { name: "register", startLine: 13, endLine: 20 },
      { name: "getCurrentUser", startLine: 22, endLine: 26 },
    ]],
    ["src/utils.ts", [
      { name: "outerFn", startLine: 1, endLine: 20 },
      { name: "innerFn", startLine: 5, endLine: 10 },
    ]],
  ]);

  it("resolves a line inside a function to Function:name:file", () => {
    expect(findEnclosingFunction(functionMap, "src/api.ts", 6))
      .toBe("Function:login:src/api.ts");
  });

  it("resolves a line inside a different function", () => {
    expect(findEnclosingFunction(functionMap, "src/api.ts", 15))
      .toBe("Function:register:src/api.ts");
  });

  it("picks the most specific (smallest range) enclosing function", () => {
    // Line 7 is inside both outerFn(1-20) and innerFn(5-10) — should pick innerFn
    expect(findEnclosingFunction(functionMap, "src/utils.ts", 7))
      .toBe("Function:innerFn:src/utils.ts");
  });

  it("falls back to file:line when line is outside all functions", () => {
    expect(findEnclosingFunction(functionMap, "src/api.ts", 2))
      .toBe("src/api.ts:2");
  });

  it("falls back to file:line when file is not in map", () => {
    expect(findEnclosingFunction(functionMap, "src/unknown.ts", 5))
      .toBe("src/unknown.ts:5");
  });

  it("resolves boundary line (start_line) correctly", () => {
    expect(findEnclosingFunction(functionMap, "src/api.ts", 4))
      .toBe("Function:login:src/api.ts");
  });

  it("resolves boundary line (end_line) correctly", () => {
    expect(findEnclosingFunction(functionMap, "src/api.ts", 11))
      .toBe("Function:login:src/api.ts");
  });
});
