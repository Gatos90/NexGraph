import { describe, it, expect } from "vitest";
import { getFrameworkMultiplier, isTestFile } from "./framework-detection.js";

describe("getFrameworkMultiplier", () => {
  it("returns 3.0 for controller paths", () => {
    expect(getFrameworkMultiplier("src/controllers/user.ts")).toBe(3.0);
    expect(getFrameworkMultiplier("src/controller/auth.ts")).toBe(3.0);
  });

  it("returns 3.0 for pages paths", () => {
    expect(getFrameworkMultiplier("src/pages/home.tsx")).toBe(3.0);
  });

  it("returns 3.0 for Next.js API routes", () => {
    expect(getFrameworkMultiplier("app/api/users/route.ts")).toBe(3.0);
    expect(getFrameworkMultiplier("src/app/api/route.ts")).toBe(3.0);
  });

  it("returns 2.5 for route paths", () => {
    expect(getFrameworkMultiplier("src/routes/api.ts")).toBe(2.5);
    expect(getFrameworkMultiplier("src/router/main.ts")).toBe(2.5);
    expect(getFrameworkMultiplier("auth.routes.ts")).toBe(2.5);
  });

  it("returns 2.0 for handler paths", () => {
    expect(getFrameworkMultiplier("src/handlers/webhook.ts")).toBe(2.0);
  });

  it("returns 1.5 for service paths", () => {
    expect(getFrameworkMultiplier("src/services/user.ts")).toBe(1.5);
  });

  it("returns 1.5 for middleware paths", () => {
    expect(getFrameworkMultiplier("src/middleware/auth.ts")).toBe(1.5);
  });

  it("returns 2.0 for worker/command paths", () => {
    expect(getFrameworkMultiplier("src/workers/indexer.ts")).toBe(2.0);
    expect(getFrameworkMultiplier("src/commands/seed.ts")).toBe(2.0);
  });

  it("returns 0.5 for test files (early return)", () => {
    expect(getFrameworkMultiplier("src/controllers/user.test.ts")).toBe(0.5);
    expect(getFrameworkMultiplier("src/__tests__/auth.ts")).toBe(0.5);
    expect(getFrameworkMultiplier("src/test/integration.ts")).toBe(0.5);
    expect(getFrameworkMultiplier("src/user.spec.ts")).toBe(0.5);
  });

  it("returns 1.0 for generic paths", () => {
    expect(getFrameworkMultiplier("src/utils/helpers.ts")).toBe(1.0);
    expect(getFrameworkMultiplier("src/config.ts")).toBe(1.0);
    expect(getFrameworkMultiplier("src/index.ts")).toBe(1.0);
  });
});

describe("isTestFile", () => {
  it("returns true for test files", () => {
    expect(isTestFile("src/user.test.ts")).toBe(true);
    expect(isTestFile("src/user.spec.ts")).toBe(true);
    expect(isTestFile("src/test/integration.ts")).toBe(true);
    expect(isTestFile("src/__tests__/unit.ts")).toBe(true);
    expect(isTestFile("src/spec/helpers.ts")).toBe(true);
  });

  it("returns false for non-test files", () => {
    expect(isTestFile("src/utils.ts")).toBe(false);
    expect(isTestFile("src/controllers/user.ts")).toBe(false);
    expect(isTestFile("src/testing-utils.ts")).toBe(false);
  });
});
