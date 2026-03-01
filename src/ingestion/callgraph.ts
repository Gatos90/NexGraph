import fsp from "node:fs/promises";
import Parser from "tree-sitter";
import { pool } from "../db/connection.js";
import { cypherWithClient } from "../db/age.js";
import type { AgeVertex, AgeEdge } from "../db/age.js";
import { createChildLogger } from "../logger.js";
import { detectLanguage } from "./structure.js";
import { getGrammarForFile } from "./parse-core.js";
import type { ExtractResult, ProgressCallback } from "./extract.js";

const logger = createChildLogger("callgraph");

type SyntaxNode = Parser.SyntaxNode;

// ─── Language Setup ─────────────────────────────────────────

const PARSE_OPTIONS: Parser.Options = {
  bufferSize: 1024 * 1024,
};

/** Languages for which we can extract call graph edges. */
const CALL_GRAPH_LANGUAGES = new Set([
  "typescript", "javascript", "python", "java", "go", "rust",
]);

// ─── Types ──────────────────────────────────────────────────

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

interface InheritanceInfo {
  className: string;
  superClass: string | null;
  interfaces: string[];
  filePath: string;
  decorators: string[];
}

interface CallSite {
  callerName: string;
  callerClass: string;
  callerFilePath: string;
  calleeName: string;
  calleeQualifier: string; // e.g. "this", "super", object name
  line: number;
}

export interface CallGraphResult {
  callsEdgeCount: number;
  extendsEdgeCount: number;
  implementsEdgeCount: number;
  overridesEdgeCount: number;
  handlesEdgeCount: number;
  decoratorsUpdated: number;
  filesProcessed: number;
}

// ─── AST Call Extraction (TS/JS) ────────────────────────────

function extractCallSites(
  rootNode: SyntaxNode,
  filePath: string,
): CallSite[] {
  const calls: CallSite[] = [];
  const scopeStack: Array<{ name: string; className: string }> = [];

  function currentScope(): { name: string; className: string } {
    return scopeStack.length > 0
      ? scopeStack[scopeStack.length - 1]
      : { name: "(top-level)", className: "" };
  }

  function visit(node: SyntaxNode): void {
    let pushed = false;

    // Track function/method scope
    if (
      node.type === "function_declaration" ||
      node.type === "generator_function_declaration"
    ) {
      const name = node.childForFieldName("name")?.text ?? "(anonymous)";
      scopeStack.push({ name, className: "" });
      pushed = true;
    } else if (node.type === "method_definition") {
      const name = node.childForFieldName("name")?.text ?? "(anonymous)";
      // Find enclosing class
      let className = "";
      let parent = node.parent;
      while (parent) {
        if (
          parent.type === "class_declaration" ||
          parent.type === "abstract_class_declaration"
        ) {
          className = parent.childForFieldName("name")?.text ?? "";
          break;
        }
        parent = parent.parent;
      }
      scopeStack.push({ name, className });
      pushed = true;
    } else if (node.type === "arrow_function" || node.type === "function_expression") {
      // Check if assigned to a variable
      const declParent = node.parent;
      if (declParent?.type === "variable_declarator") {
        const name = declParent.childForFieldName("name")?.text ?? "(anonymous)";
        scopeStack.push({ name, className: "" });
        pushed = true;
      } else if (declParent?.type === "public_field_definition") {
        const name = declParent.childForFieldName("name")?.text ?? "(anonymous)";
        let className = "";
        let parent = declParent.parent;
        while (parent) {
          if (
            parent.type === "class_declaration" ||
            parent.type === "abstract_class_declaration"
          ) {
            className = parent.childForFieldName("name")?.text ?? "";
            break;
          }
          parent = parent.parent;
        }
        scopeStack.push({ name, className });
        pushed = true;
      }
    }

    // Extract call expressions
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      if (fn) {
        const scope = currentScope();
        const callInfo = parseCallTarget(fn);
        if (callInfo) {
          calls.push({
            callerName: scope.name,
            callerClass: scope.className,
            callerFilePath: filePath,
            calleeName: callInfo.name,
            calleeQualifier: callInfo.qualifier,
            line: node.startPosition.row + 1,
          });
        }
      }
    }

    // Also catch `new` expressions as calls to constructors
    if (node.type === "new_expression") {
      const constructor = node.childForFieldName("constructor");
      if (constructor) {
        const scope = currentScope();
        calls.push({
          callerName: scope.name,
          callerClass: scope.className,
          callerFilePath: filePath,
          calleeName: constructor.text,
          calleeQualifier: "new",
          line: node.startPosition.row + 1,
        });
      }
    }

    for (const child of node.children) {
      visit(child);
    }

    if (pushed) {
      scopeStack.pop();
    }
  }

  visit(rootNode);
  return calls;
}

function parseCallTarget(
  node: SyntaxNode,
): { name: string; qualifier: string } | null {
  if (node.type === "identifier") {
    return { name: node.text, qualifier: "" };
  }

  if (node.type === "member_expression") {
    const object = node.childForFieldName("object");
    const property = node.childForFieldName("property");
    if (property) {
      const qualifier = object?.text ?? "";
      return { name: property.text, qualifier };
    }
  }

  return null;
}

// ─── AST Inheritance Extraction (TS/JS) ─────────────────────

function extractInheritance(
  rootNode: SyntaxNode,
  filePath: string,
): InheritanceInfo[] {
  const results: InheritanceInfo[] = [];

  function processClass(node: SyntaxNode, decorators: string[]): void {
    const name = node.childForFieldName("name")?.text;
    if (!name) return;

    let superClass: string | null = null;
    const interfaces: string[] = [];

    for (const child of node.children) {
      // class Foo extends Bar
      if (child.type === "class_heritage") {
        for (const clause of child.namedChildren) {
          if (clause.type === "extends_clause") {
            // The type/value after "extends"
            const typeNode = clause.namedChildren[0];
            if (typeNode) {
              superClass = extractTypeName(typeNode);
            }
          }
          if (clause.type === "implements_clause") {
            for (const impl of clause.namedChildren) {
              const typeName = extractTypeName(impl);
              if (typeName) interfaces.push(typeName);
            }
          }
        }
      }

      // Direct extends_clause (some grammar versions)
      if (child.type === "extends_clause") {
        const typeNode = child.namedChildren[0];
        if (typeNode) {
          superClass = extractTypeName(typeNode);
        }
      }

      // Direct implements_clause
      if (child.type === "implements_clause") {
        for (const impl of child.namedChildren) {
          const typeName = extractTypeName(impl);
          if (typeName) interfaces.push(typeName);
        }
      }
    }

    results.push({
      className: name,
      superClass,
      interfaces,
      filePath,
      decorators,
    });
  }

  function extractTypeName(node: SyntaxNode): string | null {
    // Handle generic types: Foo<Bar> -> "Foo"
    if (node.type === "generic_type") {
      const nameNode = node.childForFieldName("name");
      return nameNode?.text ?? null;
    }
    if (node.type === "type_identifier" || node.type === "identifier") {
      return node.text;
    }
    // member_expression: Namespace.Type -> "Type"
    if (node.type === "member_expression" || node.type === "nested_type_identifier") {
      const property = node.childForFieldName("property") ?? node.namedChildren[node.namedChildren.length - 1];
      return property?.text ?? node.text;
    }
    return node.text || null;
  }

  function visitTop(node: SyntaxNode): void {
    for (const child of node.namedChildren) {
      if (
        child.type === "class_declaration" ||
        child.type === "abstract_class_declaration"
      ) {
        processClass(child, []);
      } else if (child.type === "export_statement") {
        const decorators: string[] = [];
        for (const inner of child.namedChildren) {
          if (inner.type === "decorator") {
            const expr = inner.namedChildren[0];
            if (expr) {
              if (expr.type === "call_expression") {
                const fn = expr.childForFieldName("function");
                if (fn) decorators.push(fn.text);
              } else {
                decorators.push(expr.text);
              }
            }
          }
          if (
            inner.type === "class_declaration" ||
            inner.type === "abstract_class_declaration"
          ) {
            processClass(inner, decorators);
          }
        }
      }
    }
  }

  visitTop(rootNode);
  return results;
}

// ─── Python Call Extraction ─────────────────────────────────

function extractPythonCallSites(
  rootNode: SyntaxNode,
  filePath: string,
): CallSite[] {
  const calls: CallSite[] = [];
  const scopeStack: Array<{ name: string; className: string }> = [];

  function currentScope(): { name: string; className: string } {
    return scopeStack.length > 0
      ? scopeStack[scopeStack.length - 1]
      : { name: "(top-level)", className: "" };
  }

  function visit(node: SyntaxNode): void {
    let pushed = false;

    if (node.type === "class_definition") {
      const name = node.childForFieldName("name")?.text ?? "(anonymous)";
      scopeStack.push({ name: "(class-scope)", className: name });
      pushed = true;
    } else if (node.type === "function_definition") {
      const name = node.childForFieldName("name")?.text ?? "(anonymous)";
      // If inside a class, this is a method
      const parentScope = currentScope();
      const className = parentScope.className || "";
      scopeStack.push({ name, className });
      pushed = true;
    }

    // Extract call expressions: foo() or obj.method()
    if (node.type === "call") {
      const fn = node.childForFieldName("function");
      if (fn) {
        const scope = currentScope();
        if (fn.type === "identifier") {
          calls.push({
            callerName: scope.name,
            callerClass: scope.className,
            callerFilePath: filePath,
            calleeName: fn.text,
            calleeQualifier: "",
            line: node.startPosition.row + 1,
          });
        } else if (fn.type === "attribute") {
          const attr = fn.childForFieldName("attribute");
          const obj = fn.childForFieldName("object");
          if (attr) {
            calls.push({
              callerName: scope.name,
              callerClass: scope.className,
              callerFilePath: filePath,
              calleeName: attr.text,
              calleeQualifier: obj?.text ?? "",
              line: node.startPosition.row + 1,
            });
          }
        }
      }
    }

    for (const child of node.children) {
      visit(child);
    }
    if (pushed) scopeStack.pop();
  }

  visit(rootNode);
  return calls;
}

function extractPythonInheritance(
  rootNode: SyntaxNode,
  filePath: string,
): InheritanceInfo[] {
  const results: InheritanceInfo[] = [];

  function visit(node: SyntaxNode): void {
    if (node.type === "class_definition") {
      const name = node.childForFieldName("name")?.text;
      if (!name) return;

      const superclasses = node.childForFieldName("superclasses");
      let superClass: string | null = null;
      const additionalBases: string[] = [];

      if (superclasses) {
        let first = true;
        for (const arg of superclasses.namedChildren) {
          const baseName = arg.type === "attribute"
            ? arg.childForFieldName("attribute")?.text ?? arg.text
            : arg.text;
          if (baseName && baseName !== "object") {
            if (first) {
              superClass = baseName;
              first = false;
            } else {
              additionalBases.push(baseName);
            }
          }
        }
      }

      results.push({
        className: name,
        superClass,
        interfaces: additionalBases, // Python uses multiple inheritance
        filePath,
        decorators: [],
      });
    }
    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(rootNode);
  return results;
}

// ─── Java Call Extraction ───────────────────────────────────

function extractJavaCallSites(
  rootNode: SyntaxNode,
  filePath: string,
): CallSite[] {
  const calls: CallSite[] = [];
  const scopeStack: Array<{ name: string; className: string }> = [];

  function currentScope(): { name: string; className: string } {
    return scopeStack.length > 0
      ? scopeStack[scopeStack.length - 1]
      : { name: "(top-level)", className: "" };
  }

  function visit(node: SyntaxNode): void {
    let pushed = false;

    if (node.type === "class_declaration" || node.type === "interface_declaration" ||
        node.type === "enum_declaration" || node.type === "record_declaration") {
      const name = node.childForFieldName("name")?.text ?? "(anonymous)";
      scopeStack.push({ name: "(class-scope)", className: name });
      pushed = true;
    } else if (node.type === "method_declaration" || node.type === "constructor_declaration") {
      const name = node.childForFieldName("name")?.text ?? currentScope().className;
      scopeStack.push({ name, className: currentScope().className });
      pushed = true;
    } else if (node.type === "lambda_expression") {
      scopeStack.push({ name: "(lambda)", className: currentScope().className });
      pushed = true;
    }

    // method_invocation: method() or obj.method()
    if (node.type === "method_invocation") {
      const nameNode = node.childForFieldName("name");
      const obj = node.childForFieldName("object");
      if (nameNode) {
        const scope = currentScope();
        calls.push({
          callerName: scope.name,
          callerClass: scope.className,
          callerFilePath: filePath,
          calleeName: nameNode.text,
          calleeQualifier: obj?.text ?? "",
          line: node.startPosition.row + 1,
        });
      }
    }

    // object_creation_expression: new Foo()
    if (node.type === "object_creation_expression") {
      const typeNode = node.childForFieldName("type");
      if (typeNode) {
        const scope = currentScope();
        // Strip generics: ArrayList<String> -> ArrayList
        const typeName = typeNode.type === "generic_type"
          ? (typeNode.namedChildren[0]?.text ?? typeNode.text)
          : typeNode.text;
        calls.push({
          callerName: scope.name,
          callerClass: scope.className,
          callerFilePath: filePath,
          calleeName: typeName,
          calleeQualifier: "new",
          line: node.startPosition.row + 1,
        });
      }
    }

    for (const child of node.children) {
      visit(child);
    }
    if (pushed) scopeStack.pop();
  }

  visit(rootNode);
  return calls;
}

function extractJavaInheritance(
  rootNode: SyntaxNode,
  filePath: string,
): InheritanceInfo[] {
  const results: InheritanceInfo[] = [];

  function visit(node: SyntaxNode): void {
    if (node.type === "class_declaration" || node.type === "enum_declaration") {
      const name = node.childForFieldName("name")?.text;
      if (!name) return;

      let superClass: string | null = null;
      const interfaces: string[] = [];

      for (const child of node.children) {
        if (child.type === "superclass") {
          const typeId = child.namedChildren[0];
          if (typeId) superClass = typeId.text;
        }
        if (child.type === "super_interfaces" || child.type === "interfaces") {
          const typeList = child.namedChildren.find((c) => c.type === "type_list");
          if (typeList) {
            for (const t of typeList.namedChildren) {
              interfaces.push(t.text);
            }
          }
        }
      }

      results.push({ className: name, superClass, interfaces, filePath, decorators: [] });
    }

    if (node.type === "interface_declaration") {
      const name = node.childForFieldName("name")?.text;
      if (!name) return;

      const interfaces: string[] = [];
      for (const child of node.children) {
        if (child.type === "extends_interfaces") {
          const typeList = child.namedChildren.find((c) => c.type === "type_list");
          if (typeList) {
            for (const t of typeList.namedChildren) {
              interfaces.push(t.text);
            }
          }
        }
      }
      // Interface extending interfaces → uses EXTENDS semantically
      if (interfaces.length > 0) {
        results.push({ className: name, superClass: interfaces[0], interfaces: interfaces.slice(1), filePath, decorators: [] });
      }
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(rootNode);
  return results;
}

// ─── Go Call Extraction ─────────────────────────────────────

function extractGoCallSites(
  rootNode: SyntaxNode,
  filePath: string,
): CallSite[] {
  const calls: CallSite[] = [];
  const scopeStack: Array<{ name: string; className: string }> = [];

  function currentScope(): { name: string; className: string } {
    return scopeStack.length > 0
      ? scopeStack[scopeStack.length - 1]
      : { name: "(top-level)", className: "" };
  }

  function getReceiverType(node: SyntaxNode): string {
    const receiver = node.childForFieldName("receiver");
    if (!receiver) return "";
    // parameter_list -> parameter_declaration -> type
    const paramDecl = receiver.namedChildren[0];
    if (!paramDecl) return "";
    const typeNode = paramDecl.childForFieldName("type");
    if (!typeNode) return "";
    // Strip pointer: *Foo -> Foo
    return typeNode.text.replace(/^\*/, "");
  }

  function visit(node: SyntaxNode): void {
    let pushed = false;

    if (node.type === "function_declaration") {
      const name = node.childForFieldName("name")?.text ?? "(anonymous)";
      scopeStack.push({ name, className: "" });
      pushed = true;
    } else if (node.type === "method_declaration") {
      const name = node.childForFieldName("name")?.text ?? "(anonymous)";
      const className = getReceiverType(node);
      scopeStack.push({ name, className });
      pushed = true;
    } else if (node.type === "func_literal") {
      const parent = node.parent;
      let name = "(anonymous)";
      if (parent?.type === "short_var_declaration" || parent?.type === "var_declaration") {
        const nameNode = parent.namedChildren[0];
        if (nameNode) name = nameNode.text;
      }
      scopeStack.push({ name, className: "" });
      pushed = true;
    }

    // call_expression: foo() or pkg.Func()
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      if (fn) {
        const scope = currentScope();
        if (fn.type === "identifier") {
          calls.push({
            callerName: scope.name,
            callerClass: scope.className,
            callerFilePath: filePath,
            calleeName: fn.text,
            calleeQualifier: "",
            line: node.startPosition.row + 1,
          });
        } else if (fn.type === "selector_expression") {
          const field = fn.childForFieldName("field");
          const operand = fn.childForFieldName("operand");
          if (field) {
            calls.push({
              callerName: scope.name,
              callerClass: scope.className,
              callerFilePath: filePath,
              calleeName: field.text,
              calleeQualifier: operand?.text ?? "",
              line: node.startPosition.row + 1,
            });
          }
        }
      }
    }

    for (const child of node.children) {
      visit(child);
    }
    if (pushed) scopeStack.pop();
  }

  visit(rootNode);
  return calls;
}

function extractGoInheritance(
  rootNode: SyntaxNode,
  filePath: string,
): InheritanceInfo[] {
  const results: InheritanceInfo[] = [];

  function visit(node: SyntaxNode): void {
    // Look for type_declaration -> type_spec -> struct_type with embedded fields
    if (node.type === "type_declaration") {
      for (const spec of node.namedChildren) {
        if (spec.type === "type_spec") {
          const name = spec.childForFieldName("name")?.text;
          const typeNode = spec.childForFieldName("type");
          if (!name || !typeNode || typeNode.type !== "struct_type") continue;

          // Find embedded types (field declarations with no name, only a type)
          const fieldList = typeNode.namedChildren.find((c) => c.type === "field_declaration_list");
          if (!fieldList) continue;

          const embeddedTypes: string[] = [];
          for (const field of fieldList.namedChildren) {
            if (field.type === "field_declaration") {
              // Embedded field: has type but no name
              const fieldName = field.childForFieldName("name");
              if (!fieldName) {
                const fieldType = field.childForFieldName("type");
                if (fieldType) {
                  const typeName = fieldType.text.replace(/^\*/, "");
                  embeddedTypes.push(typeName);
                }
              }
            }
          }

          if (embeddedTypes.length > 0) {
            results.push({
              className: name,
              superClass: embeddedTypes[0],
              interfaces: embeddedTypes.slice(1),
              filePath,
              decorators: [],
            });
          }
        }
      }
    }
    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(rootNode);
  return results;
}

// ─── Rust Call Extraction ───────────────────────────────────

function extractRustCallSites(
  rootNode: SyntaxNode,
  filePath: string,
): CallSite[] {
  const calls: CallSite[] = [];
  const scopeStack: Array<{ name: string; className: string }> = [];

  function currentScope(): { name: string; className: string } {
    return scopeStack.length > 0
      ? scopeStack[scopeStack.length - 1]
      : { name: "(top-level)", className: "" };
  }

  function visit(node: SyntaxNode): void {
    let pushed = false;

    if (node.type === "function_item") {
      const name = node.childForFieldName("name")?.text ?? "(anonymous)";
      // If inside an impl block, inherit the className
      const parentScope = currentScope();
      scopeStack.push({ name, className: parentScope.className });
      pushed = true;
    } else if (node.type === "impl_item") {
      const typeNode = node.childForFieldName("type");
      const className = typeNode?.text ?? "";
      scopeStack.push({ name: "(impl-scope)", className });
      pushed = true;
    } else if (node.type === "trait_item") {
      const name = node.childForFieldName("name")?.text ?? "";
      scopeStack.push({ name: "(trait-scope)", className: name });
      pushed = true;
    } else if (node.type === "closure_expression") {
      const parent = node.parent;
      let name = "(closure)";
      if (parent?.type === "let_declaration") {
        const pat = parent.childForFieldName("pattern");
        if (pat) name = pat.text;
      }
      scopeStack.push({ name, className: currentScope().className });
      pushed = true;
    }

    // call_expression
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      if (fn) {
        const scope = currentScope();
        if (fn.type === "identifier") {
          calls.push({
            callerName: scope.name,
            callerClass: scope.className,
            callerFilePath: filePath,
            calleeName: fn.text,
            calleeQualifier: "",
            line: node.startPosition.row + 1,
          });
        } else if (fn.type === "scoped_identifier") {
          // e.g., module::func or Type::method
          const name = fn.childForFieldName("name");
          const pathNode = fn.childForFieldName("path");
          if (name) {
            calls.push({
              callerName: scope.name,
              callerClass: scope.className,
              callerFilePath: filePath,
              calleeName: name.text,
              calleeQualifier: pathNode?.text ?? "",
              line: node.startPosition.row + 1,
            });
          }
        } else if (fn.type === "field_expression") {
          // obj.method()
          const field = fn.childForFieldName("field");
          const value = fn.childForFieldName("value");
          if (field) {
            calls.push({
              callerName: scope.name,
              callerClass: scope.className,
              callerFilePath: filePath,
              calleeName: field.text,
              calleeQualifier: value?.text ?? "",
              line: node.startPosition.row + 1,
            });
          }
        } else if (fn.type === "generic_function") {
          // foo::<Type>() — extract base function name
          const innerFn = fn.namedChildren[0];
          if (innerFn?.type === "identifier") {
            calls.push({
              callerName: scope.name,
              callerClass: scope.className,
              callerFilePath: filePath,
              calleeName: innerFn.text,
              calleeQualifier: "",
              line: node.startPosition.row + 1,
            });
          } else if (innerFn?.type === "scoped_identifier") {
            const name = innerFn.childForFieldName("name");
            const pathNode = innerFn.childForFieldName("path");
            if (name) {
              calls.push({
                callerName: scope.name,
                callerClass: scope.className,
                callerFilePath: filePath,
                calleeName: name.text,
                calleeQualifier: pathNode?.text ?? "",
                line: node.startPosition.row + 1,
              });
            }
          }
        }
      }
    }

    for (const child of node.children) {
      visit(child);
    }
    if (pushed) scopeStack.pop();
  }

  visit(rootNode);
  return calls;
}

function extractRustInheritance(
  rootNode: SyntaxNode,
  filePath: string,
): InheritanceInfo[] {
  const results: InheritanceInfo[] = [];

  function visit(node: SyntaxNode): void {
    // impl Trait for Type -> IMPLEMENTS edge
    if (node.type === "impl_item") {
      const trait = node.childForFieldName("trait");
      const type = node.childForFieldName("type");
      if (trait && type) {
        results.push({
          className: type.text,
          superClass: null,
          interfaces: [trait.text],
          filePath,
          decorators: [],
        });
      }
    }
    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(rootNode);
  return results;
}

// ─── Unified Multi-Language Dispatcher ──────────────────────

interface LanguageCallData {
  callSites: CallSite[];
  inheritance: InheritanceInfo[];
}

function extractLanguageCallData(
  rootNode: SyntaxNode,
  filePath: string,
  language: string,
): LanguageCallData {
  switch (language) {
    case "typescript":
    case "javascript":
      return {
        callSites: extractCallSites(rootNode, filePath),
        inheritance: extractInheritance(rootNode, filePath),
      };
    case "python":
      return {
        callSites: extractPythonCallSites(rootNode, filePath),
        inheritance: extractPythonInheritance(rootNode, filePath),
      };
    case "java":
      return {
        callSites: extractJavaCallSites(rootNode, filePath),
        inheritance: extractJavaInheritance(rootNode, filePath),
      };
    case "go":
      return {
        callSites: extractGoCallSites(rootNode, filePath),
        inheritance: extractGoInheritance(rootNode, filePath),
      };
    case "rust":
      return {
        callSites: extractRustCallSites(rootNode, filePath),
        inheritance: extractRustInheritance(rootNode, filePath),
      };
    default:
      return { callSites: [], inheritance: [] };
  }
}

// ─── Levenshtein Distance ───────────────────────────────────

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // Use single-row optimization
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,       // deletion
        curr[j - 1] + 1,   // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

function levenshteinSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  return 1.0 - levenshtein(a, b) / maxLen;
}

// ─── Three-Tier Call Resolution ─────────────────────────────

type ResolutionMethod = "exact_import" | "fuzzy" | "heuristic";

interface ResolvedCall {
  callerId: number;
  calleeId: number;
  confidence: number;
  method: ResolutionMethod;
}

function resolveCallsForFile(
  callSites: CallSite[],
  callerSymbols: SymbolInfo[],
  allSymbols: Map<string, SymbolInfo[]>,
  importedFiles: Set<string>,
  filePath: string,
): ResolvedCall[] {
  const resolved: ResolvedCall[] = [];
  const edgeSet = new Set<string>();

  for (const call of callSites) {
    // Find the caller symbol
    const caller = findCallerSymbol(call, callerSymbols);
    if (!caller) continue;

    // Tier 1: Exact match via import map (confidence 0.90–0.95)
    const exactMatch = resolveExact(call, allSymbols, importedFiles, filePath);
    if (exactMatch) {
      const key = `${caller.id}->${exactMatch.id}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        resolved.push({
          callerId: caller.id,
          calleeId: exactMatch.id,
          confidence: call.calleeQualifier === "" ? 0.95 : 0.90,
          method: "exact_import",
        });
      }
      continue;
    }

    // Tier 2: Fuzzy match via Levenshtein distance (confidence 0.60–0.80)
    const fuzzyMatch = resolveFuzzy(call, allSymbols, importedFiles);
    if (fuzzyMatch) {
      const key = `${caller.id}->${fuzzyMatch.symbol.id}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        resolved.push({
          callerId: caller.id,
          calleeId: fuzzyMatch.symbol.id,
          confidence: 0.60 + fuzzyMatch.similarity * 0.20,
          method: "fuzzy",
        });
      }
      continue;
    }

    // Tier 3: Heuristic match (confidence 0.40–0.60)
    const heuristicMatch = resolveHeuristic(call, allSymbols);
    if (heuristicMatch) {
      const key = `${caller.id}->${heuristicMatch.id}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        resolved.push({
          callerId: caller.id,
          calleeId: heuristicMatch.id,
          confidence: heuristicMatch.exported ? 0.55 : 0.40,
          method: "heuristic",
        });
      }
    }
  }

  return resolved;
}

function findCallerSymbol(
  call: CallSite,
  symbols: SymbolInfo[],
): SymbolInfo | null {
  // Find the most specific match: same name + class
  for (const s of symbols) {
    if (s.name === call.callerName && s.className === call.callerClass) {
      return s;
    }
  }
  // Fallback: name-only match
  for (const s of symbols) {
    if (s.name === call.callerName) {
      return s;
    }
  }
  return null;
}

function resolveExact(
  call: CallSite,
  allSymbols: Map<string, SymbolInfo[]>,
  importedFiles: Set<string>,
  currentFile: string,
): SymbolInfo | null {
  const targetName = call.calleeName;

  // Search in imported files first (highest confidence)
  for (const importedFile of importedFiles) {
    const symbols = allSymbols.get(importedFile);
    if (!symbols) continue;

    for (const s of symbols) {
      if (s.name === targetName && s.exported) {
        return s;
      }
    }
  }

  // Search in same file
  const sameFileSymbols = allSymbols.get(currentFile);
  if (sameFileSymbols) {
    for (const s of sameFileSymbols) {
      if (s.name === targetName) {
        return s;
      }
    }
  }

  return null;
}

function resolveFuzzy(
  call: CallSite,
  allSymbols: Map<string, SymbolInfo[]>,
  importedFiles: Set<string>,
): { symbol: SymbolInfo; similarity: number } | null {
  const targetName = call.calleeName;
  if (targetName.length < 3) return null; // Too short for fuzzy matching

  let bestMatch: { symbol: SymbolInfo; similarity: number } | null = null;
  const threshold = 0.70;

  // Only fuzzy-match against imported files to limit false positives
  for (const importedFile of importedFiles) {
    const symbols = allSymbols.get(importedFile);
    if (!symbols) continue;

    for (const s of symbols) {
      if (!s.exported) continue;
      const sim = levenshteinSimilarity(
        targetName.toLowerCase(),
        s.name.toLowerCase(),
      );
      if (sim >= threshold && (!bestMatch || sim > bestMatch.similarity)) {
        bestMatch = { symbol: s, similarity: sim };
      }
    }
  }

  return bestMatch;
}

function resolveHeuristic(
  call: CallSite,
  allSymbols: Map<string, SymbolInfo[]>,
): SymbolInfo | null {
  const targetName = call.calleeName;

  // Skip common built-ins and known globals
  if (isBuiltinOrGlobal(targetName)) return null;

  // Search all exported symbols across all files
  let bestCandidate: SymbolInfo | null = null;

  for (const [, symbols] of allSymbols) {
    for (const s of symbols) {
      if (s.name === targetName && s.exported) {
        if (!bestCandidate) {
          bestCandidate = s;
        }
        // If multiple matches, prefer functions/methods over other types
        if (
          (s.label === "Function" || s.label === "Method") &&
          bestCandidate.label !== "Function" &&
          bestCandidate.label !== "Method"
        ) {
          bestCandidate = s;
        }
      }
    }
  }

  return bestCandidate;
}

// ─── Built-in / Global Filter ────────────────────────────────
// Module-level constant: created once, shared across all calls.
// Covers JS/TS, Python, Java, Go, Rust, C/C++, and Linux kernel builtins.

const BUILTIN_NAMES: ReadonlySet<string> = new Set([
  // ── JS/TS common globals ──
  "console", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURI", "decodeURI",
  "encodeURIComponent", "decodeURIComponent", "JSON", "Math", "Date",
  "Array", "Object", "String", "Number", "Boolean", "Symbol", "Map",
  "Set", "WeakMap", "WeakSet", "Promise", "Proxy", "Reflect",
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError",
  "RegExp", "Buffer", "process", "require", "module", "exports",
  "fetch", "Response", "Request", "URL", "URLSearchParams",
  "TextEncoder", "TextDecoder", "AbortController", "Headers",
  "FormData", "Blob", "File", "ReadableStream", "WritableStream",
  "queueMicrotask", "structuredClone", "atob", "btoa",
  // ── React hooks (too generic to resolve) ──
  "useState", "useEffect", "useCallback", "useMemo", "useRef",
  "useContext", "useReducer", "useLayoutEffect", "useImperativeHandle",
  // ── Common logging/assertion ──
  "log", "warn", "error", "info", "debug", "assert", "expect",
  "describe", "it", "test", "beforeEach", "afterEach", "beforeAll", "afterAll",
  // ── Common utility names too generic to resolve ──
  "toString", "valueOf", "hasOwnProperty", "constructor",
  "then", "catch", "finally", "next", "done", "resolve", "reject",
  "push", "pop", "shift", "unshift", "map", "filter", "reduce",
  "forEach", "find", "findIndex", "includes", "indexOf", "slice",
  "splice", "concat", "join", "sort", "reverse", "keys", "values",
  "entries", "get", "set", "has", "delete", "add", "clear", "size",

  // ── Python builtins ──
  "print", "len", "range", "super", "isinstance", "issubclass",
  "type", "list", "dict", "tuple", "str", "int", "float", "bool",
  "enumerate", "zip", "iter", "any", "all",
  "min", "max", "sum", "abs", "round", "repr", "hash", "id",
  "callable", "staticmethod", "classmethod", "property",
  "open", "input", "format", "vars", "dir", "help",
  "getattr", "setattr", "hasattr", "delattr",
  "sorted", "reversed", "hex", "oct", "bin", "ord", "chr",
  "pow", "divmod", "object", "Exception", "BaseException",
  "append", "extend", "insert", "remove", "copy", "update",
  "items", "setdefault",
  "__init__", "__str__", "__repr__", "__len__", "__getitem__",
  "__setitem__", "__delitem__", "__contains__", "__iter__",
  "__next__", "__enter__", "__exit__", "__call__",

  // ── Java builtins / Object methods / Collections ──
  "equals", "hashCode", "getClass", "wait", "notify", "notifyAll",
  "compareTo", "iterator", "length", "isEmpty", "contains",
  "containsKey", "containsValue", "entrySet", "keySet", "stream",
  "toArray", "charAt", "substring", "trim", "split", "matches",
  "currentThread", "sleep", "yield", "start", "run", "close",
  "read", "write", "flush", "println", "printf",
  "getName", "setName", "forName",

  // ── Go builtins ──
  "make", "cap", "copy", "panic", "recover", "new",
  "complex", "real", "imag",
  "Println", "Printf", "Sprintf", "Fprintf", "Errorf",
  "Print", "Fprint", "Fprintln", "Sprint", "Sprintln",

  // ── Rust builtins / macros (name without !) ──
  "println", "eprintln", "eprint",
  "write", "writeln",
  "vec", "todo", "unimplemented", "unreachable",
  "assert_eq", "assert_ne",
  "debug_assert", "debug_assert_eq", "debug_assert_ne",
  "cfg", "env", "include_str", "include_bytes",
  "dbg", "clone", "drop", "into", "from",
  "as_ref", "as_mut", "borrow", "deref", "default", "display",
  "Ok", "Err", "Some", "None",
  "unwrap", "unwrap_or", "unwrap_or_else", "expect",
  "ok", "err", "and_then", "or_else",
  "is_ok", "is_err", "is_some", "is_none",
  "into_iter", "collect",
  "to_string", "to_owned",
  "is_empty", "get_mut",

  // ── C/C++ standard library ──
  "printf", "fprintf", "sprintf", "snprintf", "scanf", "sscanf",
  "malloc", "calloc", "realloc", "free",
  "memcpy", "memmove", "memset", "memcmp",
  "strlen", "strcpy", "strncpy", "strcat", "strcmp", "strncmp",
  "strchr", "strstr", "strtok",
  "atoi", "atof", "atol", "strtol", "strtod", "strtoul",
  "fopen", "fclose", "fread", "fwrite", "fseek", "ftell", "fflush",
  "exit", "abort", "atexit",
  "sizeof", "typeof", "offsetof", "alignof",
  "static_cast", "dynamic_cast", "reinterpret_cast", "const_cast",

  // ── Linux kernel builtins ──
  "printk", "pr_info", "pr_err", "pr_warn", "pr_debug",
  "kmalloc", "kfree", "kzalloc", "kcalloc", "krealloc",
  "vmalloc", "vfree",
  "spin_lock", "spin_unlock", "spin_lock_irqsave", "spin_unlock_irqrestore",
  "mutex_lock", "mutex_unlock", "mutex_init",
  "list_add", "list_del", "list_for_each_entry",
  "BUG_ON", "WARN_ON", "WARN_ONCE",
  "IS_ERR", "PTR_ERR", "ERR_PTR", "ERR_CAST",
  "unlikely", "likely",
  "container_of",
  "MODULE_LICENSE", "MODULE_AUTHOR", "MODULE_DESCRIPTION",
  "EXPORT_SYMBOL", "EXPORT_SYMBOL_GPL",
]);

function isBuiltinOrGlobal(name: string): boolean {
  return BUILTIN_NAMES.has(name);
}

// ─── Main Function ──────────────────────────────────────────

/**
 * Ingestion Phase 5 (85–100%): Build call graph and relationship edges.
 *
 * Creates CALLS edges (three-tier resolution with confidence scoring),
 * EXTENDS edges (class inheritance), and IMPLEMENTS edges (interface
 * implementation). Reads existing graph symbols and IMPORTS edges to
 * inform resolution. All operations run in a single transaction.
 */
export async function buildCallGraph(
  graphName: string,
  extractResult: ExtractResult,
  onProgress?: ProgressCallback,
): Promise<CallGraphResult> {
  onProgress?.(85, "Starting call graph analysis");

  const client = await pool.connect();
  let callsEdgeCount = 0;
  let extendsEdgeCount = 0;
  let implementsEdgeCount = 0;
  let overridesEdgeCount = 0;
  let handlesEdgeCount = 0;
  let decoratorsUpdated = 0;
  let filesProcessed = 0;

  const parser = new Parser();

  try {
    await client.query("BEGIN");

    // Step 1: Load all symbol nodes from graph (85–87%)
    onProgress?.(85, "Loading symbol nodes from graph");

    const allSymbols = new Map<string, SymbolInfo[]>();
    const symbolById = new Map<number, SymbolInfo>();

    // Load File nodes for path mapping
    const fileIdMap = new Map<string, number>();
    const idToFile = new Map<number, string>();
    const fileRows = await cypherWithClient<{ v: AgeVertex }>(
      client, graphName,
      "MATCH (v:File) RETURN v",
      undefined,
      [{ name: "v" }],
    );
    for (const row of fileRows) {
      const p = row.v.properties.path as string;
      fileIdMap.set(p, row.v.id);
      idToFile.set(row.v.id, p);
    }

    // Load symbols via DEFINES edges (File -DEFINES-> Symbol)
    const definesRows = await cypherWithClient<{ f: AgeVertex; s: AgeVertex }>(
      client, graphName,
      "MATCH (f:File)-[:DEFINES]->(s) RETURN f, s",
      undefined,
      [{ name: "f" }, { name: "s" }],
    );

    for (const row of definesRows) {
      const filePath = row.f.properties.path as string;
      const sym: SymbolInfo = {
        id: row.s.id,
        label: row.s.label,
        name: row.s.properties.name as string,
        filePath,
        className: (row.s.properties.class_name as string) ?? "",
        startLine: row.s.properties.start_line as number,
        endLine: row.s.properties.end_line as number,
        exported: (row.s.properties.exported as boolean) ?? false,
      };
      symbolById.set(sym.id, sym);

      const existing = allSymbols.get(filePath);
      if (existing) {
        existing.push(sym);
      } else {
        allSymbols.set(filePath, [sym]);
      }
    }

    logger.info(
      { graphName, symbolCount: symbolById.size, fileCount: fileIdMap.size },
      "Loaded symbol nodes",
    );

    onProgress?.(87, `Loaded ${symbolById.size} symbols from ${fileIdMap.size} files`);

    // Step 2: Load IMPORTS edges to build import map (87–88%)
    const fileImports = new Map<string, Set<string>>(); // filePath -> set of imported filePaths

    const importRows = await cypherWithClient<{ e: AgeEdge }>(
      client, graphName,
      "MATCH ()-[e:IMPORTS]->() RETURN e",
      undefined,
      [{ name: "e" }],
    );

    for (const row of importRows) {
      const fromPath = idToFile.get(row.e.start_id);
      const toPath = idToFile.get(row.e.end_id);
      if (fromPath && toPath) {
        let imports = fileImports.get(fromPath);
        if (!imports) {
          imports = new Set();
          fileImports.set(fromPath, imports);
        }
        imports.add(toPath);
      }
    }

    onProgress?.(88, `Loaded import graph: ${importRows.length} IMPORTS edges`);

    // Step 3: Build class name -> symbol ID map for inheritance resolution
    const classNameToSymbols = new Map<string, SymbolInfo[]>();
    const interfaceNameToSymbols = new Map<string, SymbolInfo[]>();

    for (const [, symbols] of allSymbols) {
      for (const s of symbols) {
        if (s.label === "Class") {
          const existing = classNameToSymbols.get(s.name);
          if (existing) existing.push(s);
          else classNameToSymbols.set(s.name, [s]);
        }
        if (s.label === "Interface") {
          const existing = interfaceNameToSymbols.get(s.name);
          if (existing) existing.push(s);
          else interfaceNameToSymbols.set(s.name, [s]);
        }
      }
    }

    // Step 4: Parse files for calls, inheritance, implements (88–97%)
    const callGraphFiles: Array<{ relativePath: string; absolutePath: string; language: string }> = [];
    for (const f of extractResult.files) {
      const lang = detectLanguage(f.relativePath);
      if (CALL_GRAPH_LANGUAGES.has(lang)) {
        callGraphFiles.push({ relativePath: f.relativePath, absolutePath: f.absolutePath, language: lang });
      }
    }

    const allResolvedCalls: ResolvedCall[] = [];
    const allInheritance: InheritanceInfo[] = [];

    for (let i = 0; i < callGraphFiles.length; i++) {
      const file = callGraphFiles[i];

      let source: string;
      try {
        source = await fsp.readFile(file.absolutePath, "utf-8");
      } catch {
        continue;
      }

      const grammarInfo = getGrammarForFile(file.relativePath, file.language);
      if (!grammarInfo) continue;

      parser.setLanguage(grammarInfo.grammar);
      let tree: Parser.Tree;
      try {
        tree = parser.parse(source, undefined, PARSE_OPTIONS);
      } catch {
        logger.warn({ path: file.relativePath }, "Tree-sitter parse failed, skipping file for call graph");
        continue;
      }

      // Extract call sites and inheritance using language-specific dispatcher
      const { callSites, inheritance } = extractLanguageCallData(
        tree.rootNode, file.relativePath, file.language,
      );
      allInheritance.push(...inheritance);

      // Resolve calls for this file
      const fileSyms = allSymbols.get(file.relativePath) ?? [];
      const importedFiles = fileImports.get(file.relativePath) ?? new Set<string>();

      const resolved = resolveCallsForFile(
        callSites,
        fileSyms,
        allSymbols,
        importedFiles,
        file.relativePath,
      );
      allResolvedCalls.push(...resolved);

      filesProcessed++;

      if (i % 20 === 0 || i === callGraphFiles.length - 1) {
        const progress = 88 + ((i + 1) / callGraphFiles.length) * 7;
        onProgress?.(
          Math.round(progress),
          `Analyzing calls: ${i + 1}/${callGraphFiles.length} (${allResolvedCalls.length} calls, ${allInheritance.length} classes)`,
        );
      }
    }

    logger.info(
      {
        graphName,
        resolvedCalls: allResolvedCalls.length,
        inheritanceEntries: allInheritance.length,
      },
      "Call and inheritance analysis complete",
    );

    // Step 5: Create CALLS edges (95–97%)
    onProgress?.(95, `Creating ${allResolvedCalls.length} CALLS edges`);

    for (const call of allResolvedCalls) {
      // Avoid self-calls
      if (call.callerId === call.calleeId) continue;

      await cypherWithClient(
        client, graphName,
        `MATCH (a), (b) WHERE id(a) = $start_id AND id(b) = $end_id CREATE (a)-[e:CALLS {confidence: $confidence, resolution_method: $resolution_method}]->(b) RETURN e`,
        {
          start_id: call.callerId,
          end_id: call.calleeId,
          confidence: call.confidence,
          resolution_method: call.method,
        },
        [{ name: "e" }],
      );
      callsEdgeCount++;
    }

    // Step 6: Create EXTENDS and IMPLEMENTS edges (97–99%)
    onProgress?.(97, "Creating inheritance and implementation edges");

    for (const info of allInheritance) {
      // Resolve EXTENDS
      if (info.superClass) {
        const target = resolveTypeReference(
          info.superClass,
          info.filePath,
          classNameToSymbols,
          fileImports,
          allSymbols,
        );
        if (target) {
          const sourceClass = findClassSymbol(info.className, info.filePath, allSymbols);
          if (sourceClass && sourceClass.id !== target.id) {
            await cypherWithClient(
              client, graphName,
              `MATCH (a), (b) WHERE id(a) = $start_id AND id(b) = $end_id CREATE (a)-[e:EXTENDS]->(b) RETURN e`,
              { start_id: sourceClass.id, end_id: target.id },
              [{ name: "e" }],
            );
            extendsEdgeCount++;
          }
        }
      }

      // Resolve IMPLEMENTS
      for (const ifaceName of info.interfaces) {
        const target = resolveTypeReference(
          ifaceName,
          info.filePath,
          interfaceNameToSymbols,
          fileImports,
          allSymbols,
        );
        if (target) {
          const sourceClass = findClassSymbol(info.className, info.filePath, allSymbols);
          if (sourceClass && sourceClass.id !== target.id) {
            await cypherWithClient(
              client, graphName,
              `MATCH (a), (b) WHERE id(a) = $start_id AND id(b) = $end_id CREATE (a)-[e:IMPLEMENTS]->(b) RETURN e`,
              { start_id: sourceClass.id, end_id: target.id },
              [{ name: "e" }],
            );
            implementsEdgeCount++;
          }
        }
      }

      // Update decorators on class node if present
      if (info.decorators.length > 0) {
        const classSymbol = findClassSymbol(info.className, info.filePath, allSymbols);
        if (classSymbol) {
          const currentDecorators = getDecoratorString(classSymbol, symbolById);
          const mergedDecorators = mergeDecorators(currentDecorators, info.decorators);
          if (mergedDecorators !== currentDecorators) {
            await cypherWithClient(
              client, graphName,
              `MATCH (v) WHERE id(v) = $node_id SET v.decorators = $decorators RETURN v`,
              { node_id: classSymbol.id, decorators: mergedDecorators },
              [{ name: "v" }],
            );
            decoratorsUpdated++;
          }
        }
      }
    }

    // Step 7: Create OVERRIDES edges (childMethod → parentMethod) (98–99%)
    onProgress?.(98, "Detecting method overrides");

    // Build inheritance map: childClassName → parentClassName (resolved)
    const inheritanceMap = new Map<string, { parentClass: string; parentFilePath: string }>();
    for (const info of allInheritance) {
      if (info.superClass) {
        const target = resolveTypeReference(
          info.superClass,
          info.filePath,
          classNameToSymbols,
          fileImports,
          allSymbols,
        );
        if (target) {
          inheritanceMap.set(
            `${info.className}@${info.filePath}`,
            { parentClass: target.name, parentFilePath: target.filePath },
          );
        }
      }
    }

    // For each child class with a resolved parent, find method overrides
    for (const [childKey, parentInfo] of inheritanceMap) {
      const [childClassName, childFilePath] = childKey.split("@");
      const childSymbols = allSymbols.get(childFilePath) ?? [];
      const childMethods = childSymbols.filter(
        (s) => s.label === "Method" && s.className === childClassName,
      );

      if (childMethods.length === 0) continue;

      // Collect parent methods: search across all files for methods belonging to the parent class
      const parentMethods: SymbolInfo[] = [];
      for (const [, symbols] of allSymbols) {
        for (const s of symbols) {
          if (s.label === "Method" && s.className === parentInfo.parentClass && s.filePath === parentInfo.parentFilePath) {
            parentMethods.push(s);
          }
        }
      }

      if (parentMethods.length === 0) continue;

      // Build a name→symbol map for parent methods
      const parentMethodMap = new Map<string, SymbolInfo>();
      for (const pm of parentMethods) {
        parentMethodMap.set(pm.name, pm);
      }

      // Match child methods to parent methods by name
      for (const childMethod of childMethods) {
        const parentMethod = parentMethodMap.get(childMethod.name);
        if (parentMethod && childMethod.id !== parentMethod.id) {
          await cypherWithClient(
            client, graphName,
            `MATCH (a), (b) WHERE id(a) = $start_id AND id(b) = $end_id CREATE (a)-[e:OVERRIDES]->(b) RETURN e`,
            { start_id: childMethod.id, end_id: parentMethod.id },
            [{ name: "e" }],
          );
          overridesEdgeCount++;
        }
      }
    }

    logger.info(
      { graphName, overridesEdgeCount },
      "Method override detection complete",
    );

    // Step 8: Create HANDLES edges (Function → RouteHandler) (99–100%)
    onProgress?.(99, "Linking functions to route handlers");

    const routeHandlerRows = await cypherWithClient<{ rh: AgeVertex; f: AgeVertex }>(
      client, graphName,
      "MATCH (f:File)-[:EXPOSES]->(rh:RouteHandler) RETURN rh, f",
      undefined,
      [{ name: "rh" }, { name: "f" }],
    );

    for (const row of routeHandlerRows) {
      const filePath = row.f.properties.path as string;
      const handlerName = row.rh.properties.handler_name as string;
      const routeStartLine = row.rh.properties.start_line as number;
      const fileSymbols = allSymbols.get(filePath) ?? [];

      let matchedSymbol: SymbolInfo | null = null;

      // Strategy 1: Match by handler_name (high confidence)
      if (handlerName) {
        matchedSymbol = fileSymbols.find(
          (s) => (s.label === "Function" || s.label === "Method") && s.name === handlerName,
        ) ?? null;
      }

      // Strategy 2: Match by line range — find function containing the route's start_line
      if (!matchedSymbol && routeStartLine > 0) {
        let bestRange = Infinity;
        for (const s of fileSymbols) {
          if (s.label !== "Function" && s.label !== "Method") continue;
          if (s.startLine <= routeStartLine && s.endLine >= routeStartLine) {
            const range = s.endLine - s.startLine;
            if (range < bestRange) {
              bestRange = range;
              matchedSymbol = s;
            }
          }
        }
      }

      if (matchedSymbol && matchedSymbol.id !== row.rh.id) {
        await cypherWithClient(
          client, graphName,
          `MATCH (a), (b) WHERE id(a) = $start_id AND id(b) = $end_id CREATE (a)-[e:HANDLES {confidence: $confidence}]->(b) RETURN e`,
          {
            start_id: matchedSymbol.id,
            end_id: row.rh.id,
            confidence: handlerName ? 0.95 : 0.80,
          },
          [{ name: "e" }],
        );
        handlesEdgeCount++;
      }
    }

    await client.query("COMMIT");

    onProgress?.(
      100,
      `Call graph complete: ${callsEdgeCount} CALLS, ${extendsEdgeCount} EXTENDS, ${implementsEdgeCount} IMPLEMENTS, ${overridesEdgeCount} OVERRIDES, ${handlesEdgeCount} HANDLES`,
    );

    logger.info(
      {
        graphName,
        callsEdgeCount,
        extendsEdgeCount,
        implementsEdgeCount,
        overridesEdgeCount,
        handlesEdgeCount,
        decoratorsUpdated,
        filesProcessed,
      },
      "Call graph phase complete",
    );

    return {
      callsEdgeCount,
      extendsEdgeCount,
      implementsEdgeCount,
      overridesEdgeCount,
      handlesEdgeCount,
      decoratorsUpdated,
      filesProcessed,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    logger.error({ graphName, err }, "Call graph analysis failed, rolled back");
    throw err;
  } finally {
    client.release();
  }
}

// ─── Helper Functions ───────────────────────────────────────

function findClassSymbol(
  className: string,
  filePath: string,
  allSymbols: Map<string, SymbolInfo[]>,
): SymbolInfo | null {
  const fileSyms = allSymbols.get(filePath);
  if (!fileSyms) return null;
  return fileSyms.find(
    (s) => s.name === className && s.label === "Class",
  ) ?? null;
}

function resolveTypeReference(
  typeName: string,
  fromFile: string,
  nameMap: Map<string, SymbolInfo[]>,
  fileImports: Map<string, Set<string>>,
  _allSymbols: Map<string, SymbolInfo[]>,
): SymbolInfo | null {
  const candidates = nameMap.get(typeName);
  if (!candidates || candidates.length === 0) return null;

  // If only one candidate, return it
  if (candidates.length === 1) return candidates[0];

  // Prefer symbol from an imported file
  const imports = fileImports.get(fromFile);
  if (imports) {
    for (const c of candidates) {
      if (imports.has(c.filePath)) return c;
    }
  }

  // Prefer symbol from the same file
  for (const c of candidates) {
    if (c.filePath === fromFile) return c;
  }

  // Prefer exported symbols
  for (const c of candidates) {
    if (c.exported) return c;
  }

  // Return first match
  return candidates[0];
}

function getDecoratorString(
  _symbol: SymbolInfo,
  _symbolById: Map<number, SymbolInfo>,
): string {
  // Decorators are stored in graph node properties. During Phase 3,
  // class decorators are already captured. This returns empty to
  // allow mergeDecorators to add any newly discovered ones.
  return "";
}

function mergeDecorators(current: string, newDecorators: string[]): string {
  const existing = current ? current.split(",").filter(Boolean) : [];
  const merged = new Set([...existing, ...newDecorators]);
  return Array.from(merged).join(",");
}
