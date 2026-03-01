import { describe, it, expect, vi } from "vitest";

// Mock dependencies
vi.mock("../db/connection.js", () => ({
  pool: { connect: vi.fn() },
}));

vi.mock("../db/age.js", () => ({
  cypherWithClient: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { detectLanguage } from "./structure.js";

describe("detectLanguage", () => {
  it("detects TypeScript", () => {
    expect(detectLanguage("src/index.ts")).toBe("typescript");
    expect(detectLanguage("app/main.tsx")).toBe("typescript");
  });

  it("detects JavaScript", () => {
    expect(detectLanguage("lib/utils.js")).toBe("javascript");
    expect(detectLanguage("component.jsx")).toBe("javascript");
    expect(detectLanguage("server.mjs")).toBe("javascript");
  });

  it("detects Python", () => {
    expect(detectLanguage("main.py")).toBe("python");
  });

  it("detects Rust", () => {
    expect(detectLanguage("src/lib.rs")).toBe("rust");
  });

  it("detects Go", () => {
    expect(detectLanguage("main.go")).toBe("go");
  });

  it("detects Java", () => {
    expect(detectLanguage("src/Main.java")).toBe("java");
  });

  it("detects C#", () => {
    expect(detectLanguage("Program.cs")).toBe("csharp");
  });

  it("detects Ruby", () => {
    expect(detectLanguage("app.rb")).toBe("ruby");
  });

  it("detects shell scripts", () => {
    expect(detectLanguage("deploy.sh")).toBe("shell");
  });

  it("detects special filenames", () => {
    expect(detectLanguage("Dockerfile")).toBe("dockerfile");
    expect(detectLanguage("Makefile")).toBe("makefile");
    expect(detectLanguage("Gemfile")).toBe("ruby");
  });

  it("detects config files", () => {
    expect(detectLanguage("config.json")).toBe("json");
    expect(detectLanguage("config.yaml")).toBe("yaml");
    expect(detectLanguage("config.yml")).toBe("yaml");
    expect(detectLanguage("config.toml")).toBe("toml");
  });

  it("detects web files", () => {
    expect(detectLanguage("index.html")).toBe("html");
    expect(detectLanguage("styles.css")).toBe("css");
    expect(detectLanguage("styles.scss")).toBe("scss");
  });

  it("returns unknown for unrecognized extensions", () => {
    expect(detectLanguage("file.xyz")).toBe("unknown");
    expect(detectLanguage("file.abcdef")).toBe("unknown");
  });
});
