import { describe, expect, it } from "vitest";
import {
  buildTextRepresentation,
  extractCodeSnippet,
} from "./embeddings.js";

describe("extractCodeSnippet", () => {
  it("extracts the requested line range", () => {
    const content = ["line 1", "line 2", "line 3", "line 4"].join("\n");
    const snippet = extractCodeSnippet(content, 2, 3);
    expect(snippet).toBe(["line 2", "line 3"].join("\n"));
  });

  it("falls back to beginning of file when no range is provided", () => {
    const content = ["alpha", "beta", "gamma"].join("\n");
    const snippet = extractCodeSnippet(content, undefined, undefined);
    expect(snippet).toContain("alpha");
    expect(snippet).toContain("beta");
  });

  it("returns undefined for empty content", () => {
    const snippet = extractCodeSnippet("", 1, 1);
    expect(snippet).toBeUndefined();
  });
});

describe("buildTextRepresentation", () => {
  it("includes metadata and snippet content", () => {
    const text = buildTextRepresentation(
      {
        ageId: 1,
        name: "createUser",
        filePath: "src/users/service.ts",
        label: "Function",
        params: "(name: string)",
        signature: "function createUser(name: string): User",
        className: "UserService",
        startLine: 2,
        endLine: 3,
      },
      ["// header", "function createUser(name) {", "  return name;", "}"].join(
        "\n",
      ),
    );

    expect(text).toContain("Label: Function");
    expect(text).toContain("Name: createUser");
    expect(text).toContain("Path: src/users/service.ts");
    expect(text).toContain("Container: UserService");
    expect(text).toContain("Parameters: (name: string)");
    expect(text).toContain("Signature: function createUser(name: string): User");
    expect(text).toContain("Code:");
    expect(text).toContain("function createUser(name) {");
    expect(text).toContain("return name;");
  });

  it("still builds text when file content is unavailable", () => {
    const text = buildTextRepresentation({
      ageId: 9,
      name: "User",
      filePath: "src/user.ts",
      label: "Class",
    });

    expect(text).toContain("Label: Class");
    expect(text).toContain("Name: User");
    expect(text).toContain("Path: src/user.ts");
    expect(text).not.toContain("Code:");
  });
});
