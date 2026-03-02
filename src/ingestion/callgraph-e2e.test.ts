/**
 * End-to-end property-type resolution tests.
 *
 * Reads REAL source files from __fixtures__/, parses them with tree-sitter,
 * extracts call sites + property types, and verifies the full Tier 0
 * resolution pipeline connects callers → typed properties → target methods.
 */
import { describe, it, expect, vi } from "vitest";
import fsp from "node:fs/promises";
import path from "node:path";
import Parser from "tree-sitter";
import TypeScriptLanguage from "tree-sitter-typescript";
import PythonLanguage from "tree-sitter-python";
import JavaLanguage from "tree-sitter-java";
import GoLanguage from "tree-sitter-go";
import RustLanguage from "tree-sitter-rust";

// Mock DB and logger (required by module graph)
vi.mock("../db/connection.js", () => ({ pool: { connect: vi.fn() } }));
vi.mock("../db/age.js", () => ({ cypherWithClient: vi.fn() }));
vi.mock("../logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

// ─── Types (mirrored from callgraph.ts) ────────────────────

interface SymbolInfo {
  id: number;
  label: string;
  name: string;
  filePath: string;
  className: string;
  startLine: number;
  endLine: number;
  exported: boolean;
}

interface CallSite {
  callerName: string;
  callerClass: string;
  callerFilePath: string;
  calleeName: string;
  calleeQualifier: string;
  line: number;
}

interface PropertyTypeInfo {
  className: string;
  propertyName: string;
  typeName: string;
  filePath: string;
}

// ─── Call site extractors (mirrored from callgraph.ts) ──────

function extractTsJsCallSites(root: Parser.SyntaxNode, filePath: string): CallSite[] {
  const calls: CallSite[] = [];
  const scopeStack: Array<{ name: string; className: string }> = [];
  const cur = () => scopeStack.length ? scopeStack[scopeStack.length - 1] : { name: "(top-level)", className: "" };

  function visit(node: Parser.SyntaxNode): void {
    let pushed = false;
    if (node.type === "method_definition") {
      const name = node.childForFieldName("name")?.text ?? "(anonymous)";
      let className = "";
      let p = node.parent;
      while (p) {
        if (p.type === "class_declaration" || p.type === "abstract_class_declaration") { className = p.childForFieldName("name")?.text ?? ""; break; }
        p = p.parent;
      }
      scopeStack.push({ name, className }); pushed = true;
    } else if (node.type === "function_declaration" || node.type === "generator_function_declaration") {
      scopeStack.push({ name: node.childForFieldName("name")?.text ?? "(anonymous)", className: "" }); pushed = true;
    } else if (node.type === "arrow_function" || node.type === "function_expression") {
      const dp = node.parent;
      if (dp?.type === "variable_declarator") {
        scopeStack.push({ name: dp.childForFieldName("name")?.text ?? "(anonymous)", className: "" }); pushed = true;
      } else if (dp?.type === "public_field_definition") {
        const name = dp.childForFieldName("name")?.text ?? "(anonymous)";
        let className = "";
        let pp = dp.parent;
        while (pp) {
          if (pp.type === "class_declaration" || pp.type === "abstract_class_declaration") { className = pp.childForFieldName("name")?.text ?? ""; break; }
          pp = pp.parent;
        }
        scopeStack.push({ name, className }); pushed = true;
      }
    }
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      if (fn) {
        const s = cur();
        if (fn.type === "identifier") {
          calls.push({ callerName: s.name, callerClass: s.className, callerFilePath: filePath, calleeName: fn.text, calleeQualifier: "", line: node.startPosition.row + 1 });
        } else if (fn.type === "member_expression") {
          const prop = fn.childForFieldName("property");
          const obj = fn.childForFieldName("object");
          if (prop) calls.push({ callerName: s.name, callerClass: s.className, callerFilePath: filePath, calleeName: prop.text, calleeQualifier: obj?.text ?? "", line: node.startPosition.row + 1 });
        }
      }
    }
    for (const c of node.children) visit(c);
    if (pushed) scopeStack.pop();
  }
  visit(root);
  return calls;
}

function extractPythonCallSites(root: Parser.SyntaxNode, filePath: string): CallSite[] {
  const calls: CallSite[] = [];
  const scopeStack: Array<{ name: string; className: string }> = [];
  const cur = () => scopeStack.length ? scopeStack[scopeStack.length - 1] : { name: "(top-level)", className: "" };

  function visit(node: Parser.SyntaxNode): void {
    let pushed = false;
    if (node.type === "class_definition") {
      scopeStack.push({ name: "(class-scope)", className: node.childForFieldName("name")?.text ?? "" }); pushed = true;
    } else if (node.type === "function_definition") {
      const parentScope = cur();
      scopeStack.push({ name: node.childForFieldName("name")?.text ?? "(anonymous)", className: parentScope.className || "" }); pushed = true;
    }
    if (node.type === "call") {
      const fn = node.childForFieldName("function");
      if (fn) {
        const s = cur();
        if (fn.type === "identifier") {
          calls.push({ callerName: s.name, callerClass: s.className, callerFilePath: filePath, calleeName: fn.text, calleeQualifier: "", line: node.startPosition.row + 1 });
        } else if (fn.type === "attribute") {
          const attr = fn.childForFieldName("attribute");
          const obj = fn.childForFieldName("object");
          if (attr) calls.push({ callerName: s.name, callerClass: s.className, callerFilePath: filePath, calleeName: attr.text, calleeQualifier: obj?.text ?? "", line: node.startPosition.row + 1 });
        }
      }
    }
    for (const c of node.children) visit(c);
    if (pushed) scopeStack.pop();
  }
  visit(root);
  return calls;
}

function extractJavaCallSites(root: Parser.SyntaxNode, filePath: string): CallSite[] {
  const calls: CallSite[] = [];
  const scopeStack: Array<{ name: string; className: string }> = [];
  const cur = () => scopeStack.length ? scopeStack[scopeStack.length - 1] : { name: "(top-level)", className: "" };

  function visit(node: Parser.SyntaxNode): void {
    let pushed = false;
    if (node.type === "class_declaration" || node.type === "enum_declaration") {
      scopeStack.push({ name: "(class-scope)", className: node.childForFieldName("name")?.text ?? "" }); pushed = true;
    } else if (node.type === "method_declaration" || node.type === "constructor_declaration") {
      scopeStack.push({ name: node.childForFieldName("name")?.text ?? cur().className, className: cur().className }); pushed = true;
    }
    if (node.type === "method_invocation") {
      const nameNode = node.childForFieldName("name");
      const obj = node.childForFieldName("object");
      if (nameNode) {
        const s = cur();
        calls.push({ callerName: s.name, callerClass: s.className, callerFilePath: filePath, calleeName: nameNode.text, calleeQualifier: obj?.text ?? "", line: node.startPosition.row + 1 });
      }
    }
    for (const c of node.children) visit(c);
    if (pushed) scopeStack.pop();
  }
  visit(root);
  return calls;
}

function extractGoCallSites(root: Parser.SyntaxNode, filePath: string): CallSite[] {
  const calls: CallSite[] = [];
  const scopeStack: Array<{ name: string; className: string }> = [];
  const cur = () => scopeStack.length ? scopeStack[scopeStack.length - 1] : { name: "(top-level)", className: "" };

  function getReceiverType(node: Parser.SyntaxNode): string {
    const recv = node.childForFieldName("receiver");
    if (!recv) return "";
    const pd = recv.namedChildren[0];
    if (!pd) return "";
    const t = pd.childForFieldName("type");
    return t ? t.text.replace(/^\*/, "") : "";
  }

  function visit(node: Parser.SyntaxNode): void {
    let pushed = false;
    if (node.type === "function_declaration") {
      scopeStack.push({ name: node.childForFieldName("name")?.text ?? "(anonymous)", className: "" }); pushed = true;
    } else if (node.type === "method_declaration") {
      scopeStack.push({ name: node.childForFieldName("name")?.text ?? "(anonymous)", className: getReceiverType(node) }); pushed = true;
    }
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      if (fn) {
        const s = cur();
        if (fn.type === "identifier") {
          calls.push({ callerName: s.name, callerClass: s.className, callerFilePath: filePath, calleeName: fn.text, calleeQualifier: "", line: node.startPosition.row + 1 });
        } else if (fn.type === "selector_expression") {
          const field = fn.childForFieldName("field");
          const operand = fn.childForFieldName("operand");
          if (field) calls.push({ callerName: s.name, callerClass: s.className, callerFilePath: filePath, calleeName: field.text, calleeQualifier: operand?.text ?? "", line: node.startPosition.row + 1 });
        }
      }
    }
    for (const c of node.children) visit(c);
    if (pushed) scopeStack.pop();
  }
  visit(root);
  return calls;
}

function extractRustCallSites(root: Parser.SyntaxNode, filePath: string): CallSite[] {
  const calls: CallSite[] = [];
  const scopeStack: Array<{ name: string; className: string }> = [];
  const cur = () => scopeStack.length ? scopeStack[scopeStack.length - 1] : { name: "(top-level)", className: "" };

  function visit(node: Parser.SyntaxNode): void {
    let pushed = false;
    if (node.type === "function_item") {
      scopeStack.push({ name: node.childForFieldName("name")?.text ?? "(anonymous)", className: cur().className }); pushed = true;
    } else if (node.type === "impl_item") {
      scopeStack.push({ name: "(impl-scope)", className: node.childForFieldName("type")?.text ?? "" }); pushed = true;
    }
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      if (fn) {
        const s = cur();
        if (fn.type === "identifier") {
          calls.push({ callerName: s.name, callerClass: s.className, callerFilePath: filePath, calleeName: fn.text, calleeQualifier: "", line: node.startPosition.row + 1 });
        } else if (fn.type === "field_expression") {
          const field = fn.childForFieldName("field");
          const value = fn.childForFieldName("value");
          if (field) calls.push({ callerName: s.name, callerClass: s.className, callerFilePath: filePath, calleeName: field.text, calleeQualifier: value?.text ?? "", line: node.startPosition.row + 1 });
        }
      }
    }
    for (const c of node.children) visit(c);
    if (pushed) scopeStack.pop();
  }
  visit(root);
  return calls;
}

// ─── Property type extractors (mirrored from callgraph.ts) ──

function extractSimpleTypeName(t: Parser.SyntaxNode): string | null {
  if (t.type === "type_identifier" || t.type === "identifier") return t.text;
  if (t.type === "generic_type") return (t.childForFieldName("name") ?? t.namedChildren[0])?.text ?? null;
  if (t.type === "nested_type_identifier") { const ch = t.namedChildren; return ch.length ? ch[ch.length - 1].text : null; }
  return null;
}

function extractTsJsPropertyTypes(root: Parser.SyntaxNode, filePath: string): PropertyTypeInfo[] {
  const results: PropertyTypeInfo[] = [];
  function visitClass(cls: Parser.SyntaxNode): void {
    const className = cls.childForFieldName("name")?.text;
    if (!className) return;
    const body = cls.childForFieldName("body");
    if (!body) return;
    for (const member of body.namedChildren) {
      if (member.type === "method_definition") {
        if (member.childForFieldName("name")?.text === "constructor") {
          const params = member.childForFieldName("parameters");
          if (params) for (const param of params.namedChildren) {
            if (param.type !== "required_parameter") continue;
            let hasPromotion = false;
            for (const c of param.children) { if (c.type === "accessibility_modifier" || c.type === "readonly") { hasPromotion = true; break; } }
            if (!hasPromotion) continue;
            const pName = param.childForFieldName("name") ?? param.childForFieldName("pattern");
            const tAnn = param.children.find((c: Parser.SyntaxNode) => c.type === "type_annotation");
            if (pName && tAnn) { const tn = tAnn.namedChildren[0]; if (tn) { const typeName = extractSimpleTypeName(tn); if (typeName) results.push({ className, propertyName: pName.text, typeName, filePath }); } }
          }
        }
      }
      if (member.type === "public_field_definition") {
        const propName = member.childForFieldName("name")?.text;
        const value = member.childForFieldName("value");
        if (propName && value?.type === "call_expression") {
          const fn = value.childForFieldName("function");
          if (fn?.text === "inject") { const args = value.childForFieldName("arguments"); if (args) { const first = args.namedChildren[0]; if (first?.type === "identifier") { results.push({ className, propertyName: propName, typeName: first.text, filePath }); continue; } } }
        }
        if (propName && !value) {
          const tAnn = member.children.find((c: Parser.SyntaxNode) => c.type === "type_annotation");
          if (tAnn) { const tn = tAnn.namedChildren[0]; if (tn) { const typeName = extractSimpleTypeName(tn); if (typeName) results.push({ className, propertyName: propName, typeName, filePath }); } }
        }
      }
    }
  }
  for (const child of root.namedChildren) {
    if (child.type === "class_declaration" || child.type === "abstract_class_declaration") visitClass(child);
    else if (child.type === "export_statement") for (const inner of child.namedChildren) {
      if (inner.type === "class_declaration" || inner.type === "abstract_class_declaration") visitClass(inner);
    }
  }
  return results;
}

function extractPythonPropertyTypes(root: Parser.SyntaxNode, filePath: string): PropertyTypeInfo[] {
  const results: PropertyTypeInfo[] = [];
  function visitClass(node: Parser.SyntaxNode): void {
    const className = node.childForFieldName("name")?.text;
    if (!className) return;
    const body = node.childForFieldName("body");
    if (!body) return;
    for (const member of body.namedChildren) {
      if (member.type === "expression_statement") {
        const inner = member.namedChildren[0];
        if (inner?.type === "type") {
          const nameNode = inner.namedChildren[0];
          const typeNode = inner.namedChildren[1];
          if (nameNode?.type === "identifier" && typeNode) {
            const typeName = typeNode.text;
            if (typeName && /^[A-Z]/.test(typeName)) results.push({ className, propertyName: nameNode.text, typeName, filePath });
          }
        }
        if (inner?.type === "assignment") {
          const left = inner.childForFieldName("left");
          const typeNode = inner.childForFieldName("type");
          if (left?.type === "identifier" && typeNode) {
            const typeName = typeNode.text;
            if (typeName && /^[A-Z]/.test(typeName)) results.push({ className, propertyName: left.text, typeName, filePath });
          }
        }
      }
      if (member.type === "function_definition" || member.type === "decorated_definition") {
        const funcDef = member.type === "decorated_definition" ? member.namedChildren.find((c: Parser.SyntaxNode) => c.type === "function_definition") : member;
        if (!funcDef || funcDef.childForFieldName("name")?.text !== "__init__") continue;
        const paramTypeMap = new Map<string, string>();
        const params = funcDef.childForFieldName("parameters");
        if (params) for (const p of params.namedChildren) {
          if (p.type === "typed_parameter" || p.type === "typed_default_parameter") {
            const pName = p.namedChildren.find((c: Parser.SyntaxNode) => c.type === "identifier");
            const pType = p.children.find((c: Parser.SyntaxNode) => c.type === "type");
            if (pName && pType && /^[A-Z]/.test(pType.text)) paramTypeMap.set(pName.text, pType.text);
          }
        }
        if (paramTypeMap.size === 0) continue;
        const funcBody = funcDef.childForFieldName("body");
        if (!funcBody) continue;
        for (const stmt of funcBody.namedChildren) {
          if (stmt.type !== "expression_statement") continue;
          const assign = stmt.namedChildren[0];
          if (assign?.type !== "assignment") continue;
          const left = assign.childForFieldName("left");
          const right = assign.childForFieldName("right");
          if (left?.type === "attribute" && right?.type === "identifier") {
            const obj = left.childForFieldName("object");
            const attr = left.childForFieldName("attribute");
            if (obj?.text === "self" && attr) {
              const typeName = paramTypeMap.get(right.text);
              if (typeName) results.push({ className, propertyName: attr.text, typeName, filePath });
            }
          }
        }
      }
    }
  }
  function visit(node: Parser.SyntaxNode): void {
    if (node.type === "class_definition") visitClass(node);
    for (const c of node.namedChildren) visit(c);
  }
  visit(root);
  return results;
}

function extractJavaPropertyTypes(root: Parser.SyntaxNode, filePath: string): PropertyTypeInfo[] {
  const results: PropertyTypeInfo[] = [];
  function visit(node: Parser.SyntaxNode): void {
    if (node.type === "class_declaration" || node.type === "enum_declaration" || node.type === "record_declaration") {
      const className = node.childForFieldName("name")?.text;
      if (className) {
        const body = node.childForFieldName("body");
        if (body) for (const member of body.namedChildren) {
          if (member.type === "field_declaration") {
            const typeNode = member.childForFieldName("type");
            if (!typeNode) continue;
            const typeName = typeNode.type === "generic_type" ? (typeNode.namedChildren[0]?.text ?? typeNode.text) : typeNode.text;
            for (const child of member.namedChildren) {
              if (child.type === "variable_declarator") {
                const fieldName = child.childForFieldName("name")?.text;
                if (fieldName) results.push({ className, propertyName: fieldName, typeName, filePath });
              }
            }
          }
        }
      }
    }
    for (const c of node.namedChildren) visit(c);
  }
  visit(root);
  return results;
}

function extractGoPropertyTypes(root: Parser.SyntaxNode, filePath: string): PropertyTypeInfo[] {
  const results: PropertyTypeInfo[] = [];
  function visit(node: Parser.SyntaxNode): void {
    if (node.type === "type_declaration") {
      for (const spec of node.namedChildren) {
        if (spec.type !== "type_spec") continue;
        const className = spec.childForFieldName("name")?.text;
        const typeNode = spec.childForFieldName("type");
        if (!className || !typeNode || typeNode.type !== "struct_type") continue;
        const fieldList = typeNode.namedChildren.find((c: Parser.SyntaxNode) => c.type === "field_declaration_list");
        if (!fieldList) continue;
        for (const field of fieldList.namedChildren) {
          if (field.type !== "field_declaration") continue;
          const fn = field.childForFieldName("name");
          const ft = field.childForFieldName("type");
          if (!fn || !ft) continue;
          results.push({ className, propertyName: fn.text, typeName: ft.text.replace(/^\*/, ""), filePath });
        }
      }
    }
    for (const c of node.namedChildren) visit(c);
  }
  visit(root);
  return results;
}

function extractRustPropertyTypes(root: Parser.SyntaxNode, filePath: string): PropertyTypeInfo[] {
  const results: PropertyTypeInfo[] = [];
  function visit(node: Parser.SyntaxNode): void {
    if (node.type === "struct_item") {
      const className = node.childForFieldName("name")?.text;
      if (!className) return;
      const body = node.childForFieldName("body");
      if (!body || body.type !== "field_declaration_list") return;
      for (const field of body.namedChildren) {
        if (field.type !== "field_declaration") continue;
        const fn = field.childForFieldName("name")?.text;
        const typeNode = field.childForFieldName("type");
        if (!fn || !typeNode) continue;
        let typeName: string;
        if (typeNode.type === "generic_type") typeName = typeNode.namedChildren[0]?.text ?? typeNode.text;
        else if (typeNode.type === "reference_type") typeName = typeNode.namedChildren[typeNode.namedChildren.length - 1]?.text ?? typeNode.text;
        else typeName = typeNode.text;
        results.push({ className, propertyName: fn, typeName, filePath });
      }
    }
    for (const c of node.namedChildren) visit(c);
  }
  visit(root);
  return results;
}

// ─── Resolution (mirrored from callgraph.ts) ────────────────

function extractPropertyName(qualifier: string): string | null {
  if (qualifier.startsWith("this.")) { const p = qualifier.slice(5); return p.includes(".") ? null : p || null; }
  if (qualifier.startsWith("self.")) { const p = qualifier.slice(5); return p.includes(".") ? null : p || null; }
  const dot = qualifier.indexOf(".");
  if (dot > 0) { const p = qualifier.slice(dot + 1); return p.includes(".") ? null : p || null; }
  if (qualifier && !qualifier.includes(".")) return qualifier;
  return null;
}

function resolvePropertyType(
  call: CallSite,
  allSymbols: Map<string, SymbolInfo[]>,
  propertyTypeMap: Map<string, string>,
): SymbolInfo | null {
  const q = call.calleeQualifier;
  if (!q) return null;
  const propName = extractPropertyName(q);
  if (!propName) return null;
  const callerClass = call.callerClass;
  if (!callerClass) return null;
  const typeName = propertyTypeMap.get(`${callerClass}.${propName}`);
  if (!typeName) return null;
  for (const [, syms] of allSymbols) {
    for (const s of syms) {
      if (s.label === "Method" && s.className === typeName && s.name === call.calleeName) return s;
    }
  }
  return null;
}

// ─── Helpers ─────────────────────────────────────────────────

const FIXTURES = path.resolve(import.meta.dirname!, "__fixtures__");

async function readFixture(lang: string, file: string): Promise<string> {
  return fsp.readFile(path.join(FIXTURES, lang, file), "utf-8");
}

function buildPropertyTypeMap(allPropTypes: PropertyTypeInfo[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const pt of allPropTypes) m.set(`${pt.className}.${pt.propertyName}`, pt.typeName);
  return m;
}

function buildSymbolMap(
  methods: Array<{ className: string; name: string; filePath: string }>,
): Map<string, SymbolInfo[]> {
  const m = new Map<string, SymbolInfo[]>();
  let id = 1;
  for (const meth of methods) {
    const sym: SymbolInfo = { id: id++, label: "Method", name: meth.name, filePath: meth.filePath, className: meth.className, startLine: 1, endLine: 10, exported: true };
    const existing = m.get(meth.filePath);
    if (existing) existing.push(sym);
    else m.set(meth.filePath, [sym]);
  }
  return m;
}

// ─── Tests ───────────────────────────────────────────────────

describe("E2E file-based: TypeScript (Angular DI)", () => {
  const parser = new Parser();
  parser.setLanguage(TypeScriptLanguage.typescript);

  it("reads real .ts fixtures and resolves DI calls across files", async () => {
    const [authSrc, userSrc, dashSrc] = await Promise.all([
      readFixture("typescript", "auth.service.ts"),
      readFixture("typescript", "user.service.ts"),
      readFixture("typescript", "dashboard.component.ts"),
    ]);

    // Parse all three files
    const authTree = parser.parse(authSrc);
    const userTree = parser.parse(userSrc);
    const dashTree = parser.parse(dashSrc);

    // Extract property types from ALL files
    const authProps = extractTsJsPropertyTypes(authTree.rootNode, "auth.service.ts");
    const userProps = extractTsJsPropertyTypes(userTree.rootNode, "user.service.ts");
    const dashProps = extractTsJsPropertyTypes(dashTree.rootNode, "dashboard.component.ts");
    const allProps = [...authProps, ...userProps, ...dashProps];

    // Verify extraction: AuthService has http + tokenStore
    expect(authProps.find(p => p.propertyName === "http")?.typeName).toBe("HttpClient");
    expect(authProps.find(p => p.propertyName === "tokenStore")?.typeName).toBe("TokenStore");

    // Verify extraction: UserService has http + cache
    expect(userProps.find(p => p.propertyName === "http")?.typeName).toBe("HttpClient");
    expect(userProps.find(p => p.propertyName === "cache")?.typeName).toBe("CacheService");

    // Verify extraction: DashboardComponent has authService (constructor), userService (constructor),
    // notificationService (inject), analyticsTracker (typed property)
    expect(dashProps.find(p => p.propertyName === "authService")?.typeName).toBe("AuthService");
    expect(dashProps.find(p => p.propertyName === "userService")?.typeName).toBe("UserService");
    expect(dashProps.find(p => p.propertyName === "notificationService")?.typeName).toBe("NotificationService");
    expect(dashProps.find(p => p.propertyName === "analyticsTracker")?.typeName).toBe("AnalyticsTracker");

    // Extract call sites from dashboard
    const dashCalls = extractTsJsCallSites(dashTree.rootNode, "dashboard.component.ts");

    // Verify call extraction
    const isAuthCall = dashCalls.find(c => c.calleeName === "isAuthenticated" && c.calleeQualifier === "this.authService");
    const refreshCall = dashCalls.find(c => c.calleeName === "refreshToken" && c.calleeQualifier === "this.authService");
    const getProfileCall = dashCalls.find(c => c.calleeName === "getProfile" && c.calleeQualifier === "this.userService");
    const showWelcomeCall = dashCalls.find(c => c.calleeName === "showWelcome" && c.calleeQualifier === "this.notificationService");
    const logoutCall = dashCalls.find(c => c.calleeName === "logout" && c.calleeQualifier === "this.authService");
    const searchCall = dashCalls.find(c => c.calleeName === "searchUsers" && c.calleeQualifier === "this.userService");
    const trackCall = dashCalls.find(c => c.calleeName === "trackSearch" && c.calleeQualifier === "this.analyticsTracker");

    expect(isAuthCall).toBeDefined();
    expect(refreshCall).toBeDefined();
    expect(getProfileCall).toBeDefined();
    expect(showWelcomeCall).toBeDefined();
    expect(logoutCall).toBeDefined();
    expect(searchCall).toBeDefined();
    expect(trackCall).toBeDefined();

    // Also extract call sites from auth.service.ts (nested DI chain)
    const authCalls = extractTsJsCallSites(authTree.rootNode, "auth.service.ts");
    const httpPostCall = authCalls.find(c => c.calleeName === "post" && c.calleeQualifier === "this.http");
    const tokenClearCall = authCalls.find(c => c.calleeName === "clear" && c.calleeQualifier === "this.tokenStore");
    expect(httpPostCall).toBeDefined();
    expect(tokenClearCall).toBeDefined();

    // Build maps: simulate the methods that exist in the target services
    const propertyTypeMap = buildPropertyTypeMap(allProps);
    const allSymbols = buildSymbolMap([
      // AuthService methods
      { className: "AuthService", name: "login", filePath: "auth.service.ts" },
      { className: "AuthService", name: "logout", filePath: "auth.service.ts" },
      { className: "AuthService", name: "refreshToken", filePath: "auth.service.ts" },
      { className: "AuthService", name: "isAuthenticated", filePath: "auth.service.ts" },
      // UserService methods
      { className: "UserService", name: "getProfile", filePath: "user.service.ts" },
      { className: "UserService", name: "updateProfile", filePath: "user.service.ts" },
      { className: "UserService", name: "searchUsers", filePath: "user.service.ts" },
      // NotificationService methods
      { className: "NotificationService", name: "showWelcome", filePath: "notification.service.ts" },
      { className: "NotificationService", name: "showInfo", filePath: "notification.service.ts" },
      // AnalyticsTracker methods
      { className: "AnalyticsTracker", name: "trackSearch", filePath: "analytics.service.ts" },
      // HttpClient methods (for nested chain)
      { className: "HttpClient", name: "post", filePath: "http.ts" },
      { className: "HttpClient", name: "get", filePath: "http.ts" },
      { className: "HttpClient", name: "put", filePath: "http.ts" },
      // TokenStore methods
      { className: "TokenStore", name: "clear", filePath: "token-store.ts" },
      { className: "TokenStore", name: "getRefreshToken", filePath: "token-store.ts" },
      { className: "TokenStore", name: "hasValidToken", filePath: "token-store.ts" },
      // CacheService methods
      { className: "CacheService", name: "get", filePath: "cache.service.ts" },
      { className: "CacheService", name: "invalidate", filePath: "cache.service.ts" },
    ]);

    // ─── Resolve: DashboardComponent calls ───
    const r1 = resolvePropertyType(isAuthCall!, allSymbols, propertyTypeMap);
    expect(r1).not.toBeNull();
    expect(r1!.className).toBe("AuthService");
    expect(r1!.name).toBe("isAuthenticated");

    const r2 = resolvePropertyType(refreshCall!, allSymbols, propertyTypeMap);
    expect(r2).not.toBeNull();
    expect(r2!.className).toBe("AuthService");

    const r3 = resolvePropertyType(getProfileCall!, allSymbols, propertyTypeMap);
    expect(r3).not.toBeNull();
    expect(r3!.className).toBe("UserService");
    expect(r3!.name).toBe("getProfile");

    const r4 = resolvePropertyType(showWelcomeCall!, allSymbols, propertyTypeMap);
    expect(r4).not.toBeNull();
    expect(r4!.className).toBe("NotificationService");

    const r5 = resolvePropertyType(logoutCall!, allSymbols, propertyTypeMap);
    expect(r5).not.toBeNull();
    expect(r5!.className).toBe("AuthService");
    expect(r5!.name).toBe("logout");

    const r6 = resolvePropertyType(searchCall!, allSymbols, propertyTypeMap);
    expect(r6).not.toBeNull();
    expect(r6!.className).toBe("UserService");

    const r7 = resolvePropertyType(trackCall!, allSymbols, propertyTypeMap);
    expect(r7).not.toBeNull();
    expect(r7!.className).toBe("AnalyticsTracker");

    // ─── Resolve: nested chain (AuthService → HttpClient/TokenStore) ───
    const r8 = resolvePropertyType(httpPostCall!, allSymbols, propertyTypeMap);
    expect(r8).not.toBeNull();
    expect(r8!.className).toBe("HttpClient");
    expect(r8!.name).toBe("post");

    const r9 = resolvePropertyType(tokenClearCall!, allSymbols, propertyTypeMap);
    expect(r9).not.toBeNull();
    expect(r9!.className).toBe("TokenStore");
    expect(r9!.name).toBe("clear");
  });
});

describe("E2E file-based: Python (Django-style DI)", () => {
  const parser = new Parser();
  parser.setLanguage(PythonLanguage);

  it("reads real .py fixtures and resolves DI calls across files", async () => {
    const [servicesSrc, viewsSrc] = await Promise.all([
      readFixture("python", "services.py"),
      readFixture("python", "views.py"),
    ]);

    const servicesTree = parser.parse(servicesSrc);
    const viewsTree = parser.parse(viewsSrc);

    // Extract property types
    const servicesProps = extractPythonPropertyTypes(servicesTree.rootNode, "services.py");
    const viewsProps = extractPythonPropertyTypes(viewsTree.rootNode, "views.py");
    const allProps = [...servicesProps, ...viewsProps];

    // UserView: __init__ injection
    expect(viewsProps.find(p => p.className === "UserView" && p.propertyName === "user_repo")?.typeName).toBe("UserRepository");
    expect(viewsProps.find(p => p.className === "UserView" && p.propertyName === "email_service")?.typeName).toBe("EmailService");

    // OrderView: class-level annotations
    expect(viewsProps.find(p => p.className === "OrderView" && p.propertyName === "payment")?.typeName).toBe("PaymentGateway");
    expect(viewsProps.find(p => p.className === "OrderView" && p.propertyName === "user_repo")?.typeName).toBe("UserRepository");

    // Extract call sites from views
    const viewsCalls = extractPythonCallSites(viewsTree.rootNode, "views.py");

    const findByIdCall = viewsCalls.find(c => c.calleeName === "find_by_id" && c.calleeQualifier === "self.user_repo" && c.callerClass === "UserView");
    const saveCall = viewsCalls.find(c => c.calleeName === "save" && c.calleeQualifier === "self.user_repo" && c.callerClass === "UserView");
    const sendWelcomeCall = viewsCalls.find(c => c.calleeName === "send_welcome" && c.calleeQualifier === "self.email_service");
    const sendResetCall = viewsCalls.find(c => c.calleeName === "send_reset_password" && c.calleeQualifier === "self.email_service");
    const chargeCall = viewsCalls.find(c => c.calleeName === "charge" && c.calleeQualifier === "self.payment");
    const refundCall = viewsCalls.find(c => c.calleeName === "refund" && c.calleeQualifier === "self.payment");
    // OrderView also has self.user_repo.find_by_id
    const orderFindCall = viewsCalls.find(c => c.calleeName === "find_by_id" && c.calleeQualifier === "self.user_repo" && c.callerClass === "OrderView");

    expect(findByIdCall).toBeDefined();
    expect(saveCall).toBeDefined();
    expect(sendWelcomeCall).toBeDefined();
    expect(sendResetCall).toBeDefined();
    expect(chargeCall).toBeDefined();
    expect(refundCall).toBeDefined();
    expect(orderFindCall).toBeDefined();

    // Build maps
    const propertyTypeMap = buildPropertyTypeMap(allProps);
    const allSymbols = buildSymbolMap([
      { className: "UserRepository", name: "find_by_id", filePath: "services.py" },
      { className: "UserRepository", name: "find_by_email", filePath: "services.py" },
      { className: "UserRepository", name: "save", filePath: "services.py" },
      { className: "EmailService", name: "send_welcome", filePath: "services.py" },
      { className: "EmailService", name: "send_reset_password", filePath: "services.py" },
      { className: "PaymentGateway", name: "charge", filePath: "services.py" },
      { className: "PaymentGateway", name: "refund", filePath: "services.py" },
    ]);

    // Resolve
    const r1 = resolvePropertyType(findByIdCall!, allSymbols, propertyTypeMap);
    expect(r1).not.toBeNull();
    expect(r1!.className).toBe("UserRepository");
    expect(r1!.name).toBe("find_by_id");

    const r2 = resolvePropertyType(saveCall!, allSymbols, propertyTypeMap);
    expect(r2).not.toBeNull();
    expect(r2!.className).toBe("UserRepository");

    const r3 = resolvePropertyType(sendWelcomeCall!, allSymbols, propertyTypeMap);
    expect(r3).not.toBeNull();
    expect(r3!.className).toBe("EmailService");

    const r4 = resolvePropertyType(sendResetCall!, allSymbols, propertyTypeMap);
    expect(r4).not.toBeNull();
    expect(r4!.className).toBe("EmailService");

    const r5 = resolvePropertyType(chargeCall!, allSymbols, propertyTypeMap);
    expect(r5).not.toBeNull();
    expect(r5!.className).toBe("PaymentGateway");

    const r6 = resolvePropertyType(refundCall!, allSymbols, propertyTypeMap);
    expect(r6).not.toBeNull();
    expect(r6!.className).toBe("PaymentGateway");

    // OrderView.user_repo resolves to same UserRepository
    const r7 = resolvePropertyType(orderFindCall!, allSymbols, propertyTypeMap);
    expect(r7).not.toBeNull();
    expect(r7!.className).toBe("UserRepository");
  });
});

describe("E2E file-based: Java (Spring-style DI)", () => {
  const parser = new Parser();
  parser.setLanguage(JavaLanguage);

  it("reads real .java fixtures and resolves DI calls across files", async () => {
    const [userSvcSrc, notifSvcSrc, controllerSrc] = await Promise.all([
      readFixture("java", "UserService.java"),
      readFixture("java", "NotificationService.java"),
      readFixture("java", "UserController.java"),
    ]);

    const userSvcTree = parser.parse(userSvcSrc);
    const notifSvcTree = parser.parse(notifSvcSrc);
    const controllerTree = parser.parse(controllerSrc);

    // Extract property types from all files
    const userSvcProps = extractJavaPropertyTypes(userSvcTree.rootNode, "UserService.java");
    const notifSvcProps = extractJavaPropertyTypes(notifSvcTree.rootNode, "NotificationService.java");
    const controllerProps = extractJavaPropertyTypes(controllerTree.rootNode, "UserController.java");
    const allProps = [...userSvcProps, ...notifSvcProps, ...controllerProps];

    // UserService has userRepository field
    expect(userSvcProps.find(p => p.propertyName === "userRepository")?.typeName).toBe("UserRepository");

    // NotificationService has emailSender + templateEngine
    expect(notifSvcProps.find(p => p.propertyName === "emailSender")?.typeName).toBe("EmailSender");
    expect(notifSvcProps.find(p => p.propertyName === "templateEngine")?.typeName).toBe("TemplateEngine");

    // UserController has userService + notificationService + auditLogger
    expect(controllerProps.find(p => p.propertyName === "userService")?.typeName).toBe("UserService");
    expect(controllerProps.find(p => p.propertyName === "notificationService")?.typeName).toBe("NotificationService");
    expect(controllerProps.find(p => p.propertyName === "auditLogger")?.typeName).toBe("AuditLogger");

    // Extract call sites from controller
    const controllerCalls = extractJavaCallSites(controllerTree.rootNode, "UserController.java");

    // Java uses implicit this — qualifier is just "userService", "notificationService", etc.
    const findByIdCall = controllerCalls.find(c => c.calleeName === "findById" && c.calleeQualifier === "userService");
    const saveCall = controllerCalls.find(c => c.calleeName === "save" && c.calleeQualifier === "userService");
    const deleteCall = controllerCalls.find(c => c.calleeName === "deleteById" && c.calleeQualifier === "userService");
    const findAllCall = controllerCalls.find(c => c.calleeName === "findAll" && c.calleeQualifier === "userService");
    const notifyCreatedCall = controllerCalls.find(c => c.calleeName === "notifyUserCreated" && c.calleeQualifier === "notificationService");
    const logAccessCall = controllerCalls.find(c => c.calleeName === "logAccess" && c.calleeQualifier === "auditLogger");
    const logCreateCall = controllerCalls.find(c => c.calleeName === "logCreate" && c.calleeQualifier === "auditLogger");
    const logDeleteCall = controllerCalls.find(c => c.calleeName === "logDelete" && c.calleeQualifier === "auditLogger");

    expect(findByIdCall).toBeDefined();
    expect(saveCall).toBeDefined();
    expect(deleteCall).toBeDefined();
    expect(findAllCall).toBeDefined();
    expect(notifyCreatedCall).toBeDefined();
    expect(logAccessCall).toBeDefined();
    expect(logCreateCall).toBeDefined();
    expect(logDeleteCall).toBeDefined();

    // Also extract nested calls from NotificationService
    const notifCalls = extractJavaCallSites(notifSvcTree.rootNode, "NotificationService.java");
    const renderCall = notifCalls.find(c => c.calleeName === "render" && c.calleeQualifier === "templateEngine");
    const sendCall = notifCalls.find(c => c.calleeName === "send" && c.calleeQualifier === "emailSender");
    expect(renderCall).toBeDefined();
    expect(sendCall).toBeDefined();

    // Build maps
    const propertyTypeMap = buildPropertyTypeMap(allProps);
    const allSymbols = buildSymbolMap([
      { className: "UserService", name: "findById", filePath: "UserService.java" },
      { className: "UserService", name: "save", filePath: "UserService.java" },
      { className: "UserService", name: "deleteById", filePath: "UserService.java" },
      { className: "UserService", name: "findAll", filePath: "UserService.java" },
      { className: "NotificationService", name: "notifyUserCreated", filePath: "NotificationService.java" },
      { className: "NotificationService", name: "notifyPasswordReset", filePath: "NotificationService.java" },
      { className: "AuditLogger", name: "logAccess", filePath: "AuditLogger.java" },
      { className: "AuditLogger", name: "logCreate", filePath: "AuditLogger.java" },
      { className: "AuditLogger", name: "logDelete", filePath: "AuditLogger.java" },
      { className: "UserRepository", name: "findById", filePath: "UserRepository.java" },
      { className: "UserRepository", name: "save", filePath: "UserRepository.java" },
      { className: "UserRepository", name: "deleteById", filePath: "UserRepository.java" },
      { className: "UserRepository", name: "findAll", filePath: "UserRepository.java" },
      { className: "EmailSender", name: "send", filePath: "EmailSender.java" },
      { className: "TemplateEngine", name: "render", filePath: "TemplateEngine.java" },
    ]);

    // Resolve: Controller → UserService
    const r1 = resolvePropertyType(findByIdCall!, allSymbols, propertyTypeMap);
    expect(r1).not.toBeNull();
    expect(r1!.className).toBe("UserService");
    expect(r1!.name).toBe("findById");

    const r2 = resolvePropertyType(saveCall!, allSymbols, propertyTypeMap);
    expect(r2).not.toBeNull();
    expect(r2!.className).toBe("UserService");

    const r3 = resolvePropertyType(deleteCall!, allSymbols, propertyTypeMap);
    expect(r3).not.toBeNull();
    expect(r3!.className).toBe("UserService");

    const r4 = resolvePropertyType(findAllCall!, allSymbols, propertyTypeMap);
    expect(r4).not.toBeNull();
    expect(r4!.className).toBe("UserService");

    // Resolve: Controller → NotificationService
    const r5 = resolvePropertyType(notifyCreatedCall!, allSymbols, propertyTypeMap);
    expect(r5).not.toBeNull();
    expect(r5!.className).toBe("NotificationService");

    // Resolve: Controller → AuditLogger
    const r6 = resolvePropertyType(logAccessCall!, allSymbols, propertyTypeMap);
    expect(r6).not.toBeNull();
    expect(r6!.className).toBe("AuditLogger");

    // Resolve: nested — NotificationService → TemplateEngine / EmailSender
    const r7 = resolvePropertyType(renderCall!, allSymbols, propertyTypeMap);
    expect(r7).not.toBeNull();
    expect(r7!.className).toBe("TemplateEngine");

    const r8 = resolvePropertyType(sendCall!, allSymbols, propertyTypeMap);
    expect(r8).not.toBeNull();
    expect(r8!.className).toBe("EmailSender");
  });
});

describe("E2E file-based: Go (struct fields)", () => {
  const parser = new Parser();
  parser.setLanguage(GoLanguage);

  it("reads real .go fixtures and resolves receiver.field calls", async () => {
    const [dbSrc, handlerSrc] = await Promise.all([
      readFixture("go", "database.go"),
      readFixture("go", "handler.go"),
    ]);

    parser.parse(dbSrc); // verify parse doesn't crash
    const handlerTree = parser.parse(handlerSrc);

    // Extract property types
    const handlerProps = extractGoPropertyTypes(handlerTree.rootNode, "handler.go");

    // Handler struct has db, cache, logger — all pointers stripped
    expect(handlerProps.find(p => p.propertyName === "db")?.typeName).toBe("store.Database");
    expect(handlerProps.find(p => p.propertyName === "cache")?.typeName).toBe("store.CacheService");
    expect(handlerProps.find(p => p.propertyName === "logger")?.typeName).toBe("store.Logger");

    // Extract call sites from handler
    const handlerCalls = extractGoCallSites(handlerTree.rootNode, "handler.go");

    // Go: qualifier is "h.db", "h.cache", "h.logger"
    const queryCalls = handlerCalls.filter(c => c.calleeName === "Query" && c.calleeQualifier === "h.db");
    const executeCalls = handlerCalls.filter(c => c.calleeName === "Execute" && c.calleeQualifier === "h.db");
    const getCacheCall = handlerCalls.find(c => c.calleeName === "Get" && c.calleeQualifier === "h.cache");
    const setCacheCall = handlerCalls.find(c => c.calleeName === "Set" && c.calleeQualifier === "h.cache");
    const deleteCacheCall = handlerCalls.find(c => c.calleeName === "Delete" && c.calleeQualifier === "h.cache");
    const infoLogCalls = handlerCalls.filter(c => c.calleeName === "Info" && c.calleeQualifier === "h.logger");
    const errorLogCalls = handlerCalls.filter(c => c.calleeName === "Error" && c.calleeQualifier === "h.logger");

    expect(queryCalls.length).toBeGreaterThanOrEqual(2); // GetUser + ListUsers
    expect(executeCalls.length).toBeGreaterThanOrEqual(1); // DeleteUser
    expect(getCacheCall).toBeDefined();
    expect(setCacheCall).toBeDefined();
    expect(deleteCacheCall).toBeDefined();
    expect(infoLogCalls.length).toBeGreaterThanOrEqual(2);
    expect(errorLogCalls.length).toBeGreaterThanOrEqual(2);

    // Verify scope tracking — callerClass should be "Handler" for method declarations
    expect(queryCalls[0].callerClass).toBe("Handler");
    expect(getCacheCall!.callerName).toBe("GetUser");

    // Build maps — Go types include the package prefix from the fixture
    const propertyTypeMap = buildPropertyTypeMap(handlerProps);
    const allSymbols = buildSymbolMap([
      { className: "store.Database", name: "Query", filePath: "database.go" },
      { className: "store.Database", name: "Execute", filePath: "database.go" },
      { className: "store.CacheService", name: "Get", filePath: "database.go" },
      { className: "store.CacheService", name: "Set", filePath: "database.go" },
      { className: "store.CacheService", name: "Delete", filePath: "database.go" },
      { className: "store.Logger", name: "Info", filePath: "database.go" },
      { className: "store.Logger", name: "Error", filePath: "database.go" },
    ]);

    // Resolve
    const r1 = resolvePropertyType(queryCalls[0], allSymbols, propertyTypeMap);
    expect(r1).not.toBeNull();
    expect(r1!.className).toBe("store.Database");
    expect(r1!.name).toBe("Query");

    const r2 = resolvePropertyType(executeCalls[0], allSymbols, propertyTypeMap);
    expect(r2).not.toBeNull();
    expect(r2!.className).toBe("store.Database");

    const r3 = resolvePropertyType(getCacheCall!, allSymbols, propertyTypeMap);
    expect(r3).not.toBeNull();
    expect(r3!.className).toBe("store.CacheService");

    const r4 = resolvePropertyType(setCacheCall!, allSymbols, propertyTypeMap);
    expect(r4).not.toBeNull();
    expect(r4!.className).toBe("store.CacheService");

    const r5 = resolvePropertyType(infoLogCalls[0], allSymbols, propertyTypeMap);
    expect(r5).not.toBeNull();
    expect(r5!.className).toBe("store.Logger");
  });
});

describe("E2E file-based: Rust (struct fields + impl blocks)", () => {
  const parser = new Parser();
  parser.setLanguage(RustLanguage);

  it("reads real .rs fixtures and resolves self.field calls across files", async () => {
    const [servicesSrc, appSrc] = await Promise.all([
      readFixture("rust", "services.rs"),
      readFixture("rust", "app.rs"),
    ]);

    parser.parse(servicesSrc); // verify parse doesn't crash
    const appTree = parser.parse(appSrc);

    // Extract property types
    const appProps = extractRustPropertyTypes(appTree.rootNode, "app.rs");

    // AppState struct has auth, db, mailer
    expect(appProps.find(p => p.propertyName === "auth")?.typeName).toBe("AuthService");
    expect(appProps.find(p => p.propertyName === "db")?.typeName).toBe("DatabasePool");
    expect(appProps.find(p => p.propertyName === "mailer")?.typeName).toBe("MailService");

    // Extract call sites from app.rs
    const appCalls = extractRustCallSites(appTree.rootNode, "app.rs");

    // Rust: qualifier is "self.auth", "self.db", "self.mailer"
    const verifyCall = appCalls.find(c => c.calleeName === "verify" && c.calleeQualifier === "self.auth");
    const createTokenCalls = appCalls.filter(c => c.calleeName === "create_token" && c.calleeQualifier === "self.auth");
    const revokeCall = appCalls.find(c => c.calleeName === "revoke_token" && c.calleeQualifier === "self.auth");
    const executeCall = appCalls.find(c => c.calleeName === "execute" && c.calleeQualifier === "self.db");
    const queryCalls = appCalls.filter(c => c.calleeName === "query" && c.calleeQualifier === "self.db");
    const sendWelcomeCall = appCalls.find(c => c.calleeName === "send_welcome" && c.calleeQualifier === "self.mailer");
    const sendResetCall = appCalls.find(c => c.calleeName === "send_reset" && c.calleeQualifier === "self.mailer");

    expect(verifyCall).toBeDefined();
    expect(verifyCall!.callerClass).toBe("AppState");
    expect(verifyCall!.callerName).toBe("handle_login");
    expect(createTokenCalls.length).toBeGreaterThanOrEqual(1);
    expect(revokeCall).toBeDefined();
    expect(executeCall).toBeDefined();
    expect(queryCalls.length).toBeGreaterThanOrEqual(2); // handle_register + handle_reset_password
    expect(sendWelcomeCall).toBeDefined();
    expect(sendResetCall).toBeDefined();

    // Build maps
    const propertyTypeMap = buildPropertyTypeMap(appProps);
    const allSymbols = buildSymbolMap([
      { className: "AuthService", name: "verify", filePath: "services.rs" },
      { className: "AuthService", name: "create_token", filePath: "services.rs" },
      { className: "AuthService", name: "revoke_token", filePath: "services.rs" },
      { className: "DatabasePool", name: "query", filePath: "services.rs" },
      { className: "DatabasePool", name: "execute", filePath: "services.rs" },
      { className: "MailService", name: "send_welcome", filePath: "services.rs" },
      { className: "MailService", name: "send_reset", filePath: "services.rs" },
    ]);

    // Resolve
    const r1 = resolvePropertyType(verifyCall!, allSymbols, propertyTypeMap);
    expect(r1).not.toBeNull();
    expect(r1!.className).toBe("AuthService");
    expect(r1!.name).toBe("verify");

    const r2 = resolvePropertyType(createTokenCalls[0], allSymbols, propertyTypeMap);
    expect(r2).not.toBeNull();
    expect(r2!.className).toBe("AuthService");

    const r3 = resolvePropertyType(revokeCall!, allSymbols, propertyTypeMap);
    expect(r3).not.toBeNull();
    expect(r3!.className).toBe("AuthService");

    const r4 = resolvePropertyType(executeCall!, allSymbols, propertyTypeMap);
    expect(r4).not.toBeNull();
    expect(r4!.className).toBe("DatabasePool");

    const r5 = resolvePropertyType(queryCalls[0], allSymbols, propertyTypeMap);
    expect(r5).not.toBeNull();
    expect(r5!.className).toBe("DatabasePool");

    const r6 = resolvePropertyType(sendWelcomeCall!, allSymbols, propertyTypeMap);
    expect(r6).not.toBeNull();
    expect(r6!.className).toBe("MailService");

    const r7 = resolvePropertyType(sendResetCall!, allSymbols, propertyTypeMap);
    expect(r7).not.toBeNull();
    expect(r7!.className).toBe("MailService");
  });
});
