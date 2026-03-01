import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { NexGraphApiClient, ApiError } from "./api-client.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const CLIENT_OPTS = {
  baseUrl: "http://localhost:3000",
  apiKey: "test-key",
  projectId: "proj-123",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ApiError", () => {
  it("extracts error message from body", () => {
    const err = new ApiError(400, { error: "Bad request" });
    expect(err.message).toBe("Bad request");
    expect(err.status).toBe(400);
    expect(err.name).toBe("ApiError");
  });

  it("falls back to HTTP status when no error field", () => {
    const err = new ApiError(500, "raw text");
    expect(err.message).toBe("HTTP 500");
  });
});

describe("NexGraphApiClient", () => {
  describe("constructor", () => {
    it("trims trailing slash from baseUrl", () => {
      const client = new NexGraphApiClient({
        ...CLIENT_OPTS,
        baseUrl: "http://localhost:3000/",
      });
      expect(client.projectId).toBe("proj-123");
    });
  });

  describe("discover", () => {
    it("creates client from first project returned", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          projects: [{ id: "proj-1", name: "My Project" }],
        }),
      });

      const client = await NexGraphApiClient.discover({
        baseUrl: "http://localhost:3000",
        apiKey: "test-key",
      });

      expect(client.projectId).toBe("proj-1");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3000/api/v1/projects");
      expect(opts.headers.Authorization).toBe("Bearer test-key");
    });

    it("throws when no projects found", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ projects: [] }),
      });

      await expect(
        NexGraphApiClient.discover({
          baseUrl: "http://localhost:3000",
          apiKey: "key",
        }),
      ).rejects.toThrow("No projects found");
    });

    it("throws on HTTP error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      });

      await expect(
        NexGraphApiClient.discover({
          baseUrl: "http://localhost:3000",
          apiKey: "bad-key",
        }),
      ).rejects.toThrow("HTTP 401");
    });
  });

  describe("getAllRepos", () => {
    it("fetches and caches repositories", async () => {
      const client = new NexGraphApiClient(CLIENT_OPTS);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          repositories: [
            { id: "r1", name: "repo1", project_id: "proj-123", graph_name: "g1" },
          ],
        }),
      });

      const repos = await client.getAllRepos();
      expect(repos).toHaveLength(1);
      expect(repos[0].name).toBe("repo1");

      // Second call should use cache (no additional fetch)
      const repos2 = await client.getAllRepos();
      expect(repos2).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("resolveRepo", () => {
    it("finds repo by name", async () => {
      const client = new NexGraphApiClient(CLIENT_OPTS);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          repositories: [
            { id: "r1", name: "repo1", project_id: "proj-123", graph_name: "g1" },
            { id: "r2", name: "repo2", project_id: "proj-123", graph_name: "g2" },
          ],
        }),
      });

      const repo = await client.resolveRepo("repo2");
      expect(repo?.id).toBe("r2");
    });

    it("returns null for non-existent repo", async () => {
      const client = new NexGraphApiClient(CLIENT_OPTS);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ repositories: [] }),
      });

      const repo = await client.resolveRepo("nope");
      expect(repo).toBeNull();
    });

    it("returns single indexed repo when no name given", async () => {
      const client = new NexGraphApiClient(CLIENT_OPTS);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          repositories: [
            { id: "r1", name: "repo1", project_id: "proj-123", graph_name: "g1" },
          ],
        }),
      });

      const repo = await client.resolveRepo();
      expect(repo?.id).toBe("r1");
    });

    it("returns null when multiple indexed repos and no name given", async () => {
      const client = new NexGraphApiClient(CLIENT_OPTS);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          repositories: [
            { id: "r1", name: "repo1", project_id: "proj-123", graph_name: "g1" },
            { id: "r2", name: "repo2", project_id: "proj-123", graph_name: "g2" },
          ],
        }),
      });

      const repo = await client.resolveRepo();
      expect(repo).toBeNull();
    });
  });

  describe("invalidateRepoCache", () => {
    it("clears cache so next call refetches", async () => {
      const client = new NexGraphApiClient(CLIENT_OPTS);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ repositories: [] }),
      });

      await client.getAllRepos();
      client.invalidateRepoCache();
      await client.getAllRepos();

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("request methods", () => {
    it("throws ApiError on non-ok response with JSON body", async () => {
      const client = new NexGraphApiClient(CLIENT_OPTS);
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ error: "Not found" }),
      });

      await expect(
        client.getGraphStats("repo-1"),
      ).rejects.toThrow(ApiError);
    });

    it("throws ApiError on non-ok response with text body", async () => {
      const client = new NexGraphApiClient(CLIENT_OPTS);
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => { throw new Error("not json"); },
        text: async () => "Internal Server Error",
      });

      await expect(
        client.getGraphStats("repo-1"),
      ).rejects.toThrow(ApiError);
    });

    it("sends correct headers and body for POST requests", async () => {
      const client = new NexGraphApiClient(CLIENT_OPTS);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [] }),
      });

      await client.executeCypher("repo-1", {
        query: "MATCH (n) RETURN n",
        params: { limit: 10 },
      });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3000/api/v1/repositories/repo-1/graph/cypher");
      expect(opts.method).toBe("POST");
      expect(opts.headers.Authorization).toBe("Bearer test-key");
      expect(opts.headers["Content-Type"]).toBe("application/json");
      expect(JSON.parse(opts.body)).toEqual({
        query: "MATCH (n) RETURN n",
        params: { limit: 10 },
      });
    });

    it("builds query strings for GET requests", async () => {
      const client = new NexGraphApiClient(CLIENT_OPTS);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ nodes: [], count: 0 }),
      });

      await client.listNodes("repo-1", { label: "Function", limit: 5 });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("label=Function");
      expect(url).toContain("limit=5");
    });
  });
});
