/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { describe, it, expect, vi } from "vitest";

// Mock logger before importing module
vi.mock("../logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { detectRouteHandlers } from "./routes.js";
import type { DetectedRoute } from "./routes.js";

function findRoute(
  routes: DetectedRoute[],
  method: string,
  urlPattern?: string,
): DetectedRoute | undefined {
  return routes.find(
    (r) =>
      r.httpMethod === method &&
      (urlPattern === undefined || r.urlPattern === urlPattern),
  );
}

// ─── Express / Hono / Koa ───────────────────────────────────

describe("detectRouteHandlers — Express/Hono", () => {
  it("detects app.get route", () => {
    const source = `app.get("/users", handler);`;
    const routes = detectRouteHandlers(source, "typescript");
    expect(routes).toHaveLength(1);
    expect(routes[0].httpMethod).toBe("GET");
    expect(routes[0].urlPattern).toBe("/users");
    expect(routes[0].framework).toBe("express");
  });

  it("detects app.post route", () => {
    const source = `app.post("/users", createUser);`;
    const routes = detectRouteHandlers(source, "typescript");
    expect(findRoute(routes, "POST", "/users")).toBeDefined();
  });

  it("detects router.put route", () => {
    const source = `router.put("/users/:id", updateUser);`;
    const routes = detectRouteHandlers(source, "typescript");
    expect(findRoute(routes, "PUT", "/users/:id")).toBeDefined();
  });

  it("detects router.delete route", () => {
    const source = `router.delete("/users/:id", deleteUser);`;
    const routes = detectRouteHandlers(source, "typescript");
    expect(findRoute(routes, "DELETE", "/users/:id")).toBeDefined();
  });

  it("detects app.patch route", () => {
    const source = `app.patch("/users/:id", patchUser);`;
    const routes = detectRouteHandlers(source, "typescript");
    expect(findRoute(routes, "PATCH", "/users/:id")).toBeDefined();
  });

  it("detects multiple routes in same file", () => {
    const source = `
app.get("/users", listUsers);
app.post("/users", createUser);
app.get("/users/:id", getUser);
`;
    const routes = detectRouteHandlers(source, "typescript");
    expect(routes).toHaveLength(3);
  });

  it("works with JavaScript language", () => {
    const source = `app.get("/api/data", handler);`;
    const routes = detectRouteHandlers(source, "javascript");
    expect(routes).toHaveLength(1);
  });

  it("detects routes with template literals", () => {
    const source = "app.get(`/api/v1/users`, handler);";
    const routes = detectRouteHandlers(source, "typescript");
    expect(routes).toHaveLength(1);
    expect(routes[0].urlPattern).toBe("/api/v1/users");
  });

  it("captures handler name from named function reference", () => {
    const source = `router.get("/articles", getArticles);`;
    const routes = detectRouteHandlers(source, "typescript");
    expect(routes).toHaveLength(1);
    expect(routes[0].handlerName).toBe("getArticles");
  });

  it("does not capture 'async' as handler name", () => {
    const source = `router.get("/articles", async (req, res) => {});`;
    const routes = detectRouteHandlers(source, "typescript");
    expect(routes).toHaveLength(1);
    expect(routes[0].handlerName).toBe("");
  });

  it("does not capture middleware (member expression) as handler name", () => {
    const source = `router.get("/articles", auth.optional, async (req, res) => {});`;
    const routes = detectRouteHandlers(source, "typescript");
    expect(routes).toHaveLength(1);
    expect(routes[0].handlerName).toBe("");
  });

  it("captures handler names for multiple routes", () => {
    const source = `
app.get("/users", listUsers);
app.post("/users", createUser);
app.delete("/users/:id", deleteUser);
`;
    const routes = detectRouteHandlers(source, "typescript");
    expect(routes).toHaveLength(3);
    expect(routes[0].handlerName).toBe("listUsers");
    expect(routes[1].handlerName).toBe("createUser");
    expect(routes[2].handlerName).toBe("deleteUser");
  });
});

// ─── NestJS ─────────────────────────────────────────────────

describe("detectRouteHandlers — NestJS", () => {
  it("detects @Get decorator", () => {
    const source = `
@Get("/users")
getUsers() {}
`;
    const routes = detectRouteHandlers(source, "typescript");
    expect(findRoute(routes, "GET", "/users")).toBeDefined();
    expect(routes[0].framework).toBe("nestjs");
  });

  it("detects @Post with path", () => {
    const source = `@Post("/users") createUser() {}`;
    const routes = detectRouteHandlers(source, "typescript");
    expect(findRoute(routes, "POST", "/users")).toBeDefined();
  });

  it("detects @Delete decorator", () => {
    const source = `@Delete("/users/:id") deleteUser() {}`;
    const routes = detectRouteHandlers(source, "typescript");
    expect(findRoute(routes, "DELETE", "/users/:id")).toBeDefined();
  });

  it("detects @Get() with no path (defaults to /)", () => {
    const source = `@Get() getRoot() {}`;
    const routes = detectRouteHandlers(source, "typescript");
    expect(routes).toHaveLength(1);
    expect(routes[0].urlPattern).toBe("/");
  });

  it("captures method name from NestJS decorator", () => {
    const source = `
@Get("/users")
getUsers() {}
`;
    const routes = detectRouteHandlers(source, "typescript");
    const nestRoute = routes.find((r) => r.framework === "nestjs");
    expect(nestRoute).toBeDefined();
    expect(nestRoute!.handlerName).toBe("getUsers");
  });

  it("captures async method name from NestJS decorator", () => {
    const source = `
@Post("/users")
async createUser(@Body() body) {}
`;
    const routes = detectRouteHandlers(source, "typescript");
    const nestRoute = routes.find((r) => r.framework === "nestjs");
    expect(nestRoute).toBeDefined();
    expect(nestRoute!.handlerName).toBe("createUser");
  });
});

// ─── Flask ──────────────────────────────────────────────────

describe("detectRouteHandlers — Flask", () => {
  it("detects @app.route with default GET", () => {
    const source = `
@app.route("/users")
def get_users():
    pass
`;
    const routes = detectRouteHandlers(source, "python");
    expect(routes).toHaveLength(1);
    expect(routes[0].httpMethod).toBe("GET");
    expect(routes[0].urlPattern).toBe("/users");
    expect(routes[0].framework).toBe("flask");
  });

  it("detects @app.route with methods list", () => {
    const source = `
@app.route("/users", methods=['GET', 'POST'])
def users():
    pass
`;
    const routes = detectRouteHandlers(source, "python");
    expect(routes).toHaveLength(2);
    expect(findRoute(routes, "GET", "/users")).toBeDefined();
    expect(findRoute(routes, "POST", "/users")).toBeDefined();
  });

  it("detects @bp.route with blueprint", () => {
    const source = `
@bp.route("/items")
def items():
    pass
`;
    const routes = detectRouteHandlers(source, "python");
    expect(routes).toHaveLength(1);
    expect(routes[0].urlPattern).toBe("/items");
  });

  it("captures function name from Flask route", () => {
    const source = `
@app.route("/users")
def get_users():
    pass
`;
    const routes = detectRouteHandlers(source, "python");
    expect(routes).toHaveLength(1);
    expect(routes[0].handlerName).toBe("get_users");
  });
});

// ─── FastAPI ────────────────────────────────────────────────

describe("detectRouteHandlers — FastAPI", () => {
  it("detects @app.get route", () => {
    const source = `
@app.get("/items")
def get_items():
    pass
`;
    const routes = detectRouteHandlers(source, "python");
    expect(findRoute(routes, "GET", "/items")).toBeDefined();
    // Note: could match both flask and fastapi detectors
  });

  it("detects @router.post route", () => {
    const source = `
@router.post("/items")
def create_item():
    pass
`;
    const routes = detectRouteHandlers(source, "python");
    expect(routes.some((r) => r.httpMethod === "POST" && r.urlPattern === "/items")).toBe(true);
  });

  it("detects @app.delete route", () => {
    const source = `
@app.delete("/items/{item_id}")
def delete_item():
    pass
`;
    const routes = detectRouteHandlers(source, "python");
    expect(routes.some((r) => r.httpMethod === "DELETE")).toBe(true);
  });
});

// ─── Go net/http ────────────────────────────────────────────

describe("detectRouteHandlers — Go net/http", () => {
  it("detects http.HandleFunc", () => {
    const source = `http.HandleFunc("/api/users", usersHandler)`;
    const routes = detectRouteHandlers(source, "go");
    expect(routes).toHaveLength(1);
    expect(routes[0].httpMethod).toBe("ANY");
    expect(routes[0].urlPattern).toBe("/api/users");
    expect(routes[0].framework).toBe("go-net-http");
  });

  it("detects http.Handle", () => {
    const source = `http.Handle("/static/", fileServer)`;
    const routes = detectRouteHandlers(source, "go");
    // May also match Gin Handle pattern, so check for at least one go-net-http match
    const netHttpRoute = routes.find((r) => r.framework === "go-net-http");
    expect(netHttpRoute).toBeDefined();
    expect(netHttpRoute!.urlPattern).toBe("/static/");
  });

  it("captures handler name from HandleFunc", () => {
    const source = `http.HandleFunc("/api/users", usersHandler)`;
    const routes = detectRouteHandlers(source, "go");
    const netHttpRoute = routes.find((r) => r.framework === "go-net-http");
    expect(netHttpRoute).toBeDefined();
    expect(netHttpRoute!.handlerName).toBe("usersHandler");
  });
});

// ─── Gin (Go) ───────────────────────────────────────────────

describe("detectRouteHandlers — Gin", () => {
  it("detects r.GET route", () => {
    const source = `r.GET("/users", getUsers)`;
    const routes = detectRouteHandlers(source, "go");
    const gin = routes.find((r) => r.framework === "gin");
    expect(gin).toBeDefined();
    expect(gin!.httpMethod).toBe("GET");
    expect(gin!.urlPattern).toBe("/users");
  });

  it("detects r.POST route", () => {
    const source = `r.POST("/users", createUser)`;
    const routes = detectRouteHandlers(source, "go");
    expect(routes.some((r) => r.httpMethod === "POST")).toBe(true);
  });

  it("detects Any route as ANY method", () => {
    const source = `r.Any("/health", healthCheck)`;
    const routes = detectRouteHandlers(source, "go");
    const anyRoute = routes.find((r) => r.framework === "gin");
    expect(anyRoute).toBeDefined();
    expect(anyRoute!.httpMethod).toBe("ANY");
  });

  it("captures handler name from Gin route", () => {
    const source = `r.GET("/users", getUsers)`;
    const routes = detectRouteHandlers(source, "go");
    const gin = routes.find((r) => r.framework === "gin");
    expect(gin).toBeDefined();
    expect(gin!.handlerName).toBe("getUsers");
  });
});

// ─── Spring (Java) ──────────────────────────────────────────

describe("detectRouteHandlers — Spring", () => {
  it("detects @GetMapping", () => {
    const source = `@GetMapping("/users") public List<User> getUsers() {}`;
    const routes = detectRouteHandlers(source, "java");
    expect(routes).toHaveLength(1);
    expect(routes[0].httpMethod).toBe("GET");
    expect(routes[0].urlPattern).toBe("/users");
    expect(routes[0].framework).toBe("spring");
  });

  it("detects @PostMapping", () => {
    const source = `@PostMapping("/users") public User createUser() {}`;
    const routes = detectRouteHandlers(source, "java");
    expect(findRoute(routes, "POST", "/users")).toBeDefined();
  });

  it("detects @DeleteMapping", () => {
    const source = `@DeleteMapping("/users/{id}") public void delete() {}`;
    const routes = detectRouteHandlers(source, "java");
    expect(findRoute(routes, "DELETE", "/users/{id}")).toBeDefined();
  });

  it("detects @RequestMapping with method", () => {
    const source = `@RequestMapping("/api", method = RequestMethod.GET)`;
    const routes = detectRouteHandlers(source, "java");
    expect(routes).toHaveLength(1);
    expect(routes[0].httpMethod).toBe("GET");
    expect(routes[0].urlPattern).toBe("/api");
  });

  it("detects @RequestMapping without method as ANY", () => {
    const source = `@RequestMapping("/api/health")`;
    const routes = detectRouteHandlers(source, "java");
    expect(routes).toHaveLength(1);
    expect(routes[0].httpMethod).toBe("ANY");
  });

  it("detects @GetMapping with value attribute", () => {
    const source = `@GetMapping(value = "/users")`;
    const routes = detectRouteHandlers(source, "java");
    expect(findRoute(routes, "GET", "/users")).toBeDefined();
  });
});

// ─── Rails (Ruby) ───────────────────────────────────────────

describe("detectRouteHandlers — Rails", () => {
  it("detects get route", () => {
    const source = `  get '/users', to: 'users#index'`;
    const routes = detectRouteHandlers(source, "ruby");
    expect(findRoute(routes, "GET", "/users")).toBeDefined();
    expect(routes[0].framework).toBe("rails");
  });

  it("detects post route", () => {
    const source = `  post '/users', to: 'users#create'`;
    const routes = detectRouteHandlers(source, "ruby");
    expect(findRoute(routes, "POST", "/users")).toBeDefined();
  });

  it("detects match as ANY", () => {
    const source = `  match '/health', to: 'health#check'`;
    const routes = detectRouteHandlers(source, "ruby");
    expect(findRoute(routes, "ANY", "/health")).toBeDefined();
  });

  it("detects resources and generates REST routes", () => {
    const source = `  resources :users`;
    const routes = detectRouteHandlers(source, "ruby");
    // Rails resources generate 8 conventional routes
    expect(routes.length).toBe(8);
    expect(findRoute(routes, "GET", "/users")).toBeDefined();
    expect(findRoute(routes, "POST", "/users")).toBeDefined();
    expect(findRoute(routes, "GET", "/users/:id")).toBeDefined();
    expect(findRoute(routes, "PUT", "/users/:id")).toBeDefined();
    expect(findRoute(routes, "DELETE", "/users/:id")).toBeDefined();
  });
});

// ─── Language with no detectors ─────────────────────────────

describe("detectRouteHandlers — unsupported language", () => {
  it("returns empty for unsupported language", () => {
    const routes = detectRouteHandlers("anything", "rust");
    expect(routes).toEqual([]);
  });

  it("returns empty for empty source", () => {
    const routes = detectRouteHandlers("", "typescript");
    expect(routes).toEqual([]);
  });
});
