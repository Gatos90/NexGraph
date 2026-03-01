/**
 * Pure AST extraction logic — no DB or side-effectful imports.
 * Safe to import from worker threads.
 */
import Parser from "tree-sitter";
import TypeScriptLanguage from "tree-sitter-typescript";
import JavaScriptLanguage from "tree-sitter-javascript";
import PythonLanguage from "tree-sitter-python";
import RustLanguage from "tree-sitter-rust";
import GoLanguage from "tree-sitter-go";
import JavaLanguage from "tree-sitter-java";
import CSharpLanguage from "tree-sitter-c-sharp";
import CLanguage from "tree-sitter-c";
import CppLanguage from "tree-sitter-cpp";
import RubyLanguage from "tree-sitter-ruby";
import path from "node:path";

type SyntaxNode = Parser.SyntaxNode;

// ─── Language Setup ─────────────────────────────────────────

const tsGrammar = TypeScriptLanguage.typescript;
const tsxGrammar = TypeScriptLanguage.tsx;
const jsGrammar = JavaScriptLanguage;
const pyGrammar = PythonLanguage;
const rustGrammar = RustLanguage;
const goGrammar = GoLanguage;
const javaGrammar = JavaLanguage;
const csharpGrammar = CSharpLanguage;
const cGrammar = CLanguage;
const cppGrammar = CppLanguage;
const rubyGrammar = RubyLanguage;

const MAX_SIGNATURE_LENGTH = 500;
const PARSE_OPTIONS: Parser.Options = {
  // Default buffer is too small for some generated/minified files.
  bufferSize: 1024 * 1024,
};

export interface LanguageGrammar {
  grammar: Parser.Language;
  supportsTypes: boolean;
}

export function getGrammarForFile(
  relativePath: string,
  language: string,
): LanguageGrammar | null {
  if (language === "typescript") {
    const ext = path.extname(relativePath).toLowerCase();
    return {
      grammar: ext === ".tsx" ? tsxGrammar : tsGrammar,
      supportsTypes: true,
    };
  }
  if (language === "javascript") {
    return {
      grammar: jsGrammar,
      supportsTypes: false,
    };
  }
  if (language === "python") {
    return {
      grammar: pyGrammar,
      supportsTypes: false,
    };
  }
  if (language === "rust") {
    return {
      grammar: rustGrammar,
      supportsTypes: true,
    };
  }
  if (language === "go") {
    return {
      grammar: goGrammar,
      supportsTypes: true,
    };
  }
  if (language === "java") {
    return {
      grammar: javaGrammar,
      supportsTypes: true,
    };
  }
  if (language === "csharp") {
    return {
      grammar: csharpGrammar,
      supportsTypes: true,
    };
  }
  if (language === "c") {
    return {
      grammar: cGrammar,
      supportsTypes: true,
    };
  }
  if (language === "cpp") {
    return {
      grammar: cppGrammar,
      supportsTypes: true,
    };
  }
  if (language === "ruby") {
    return {
      grammar: rubyGrammar,
      supportsTypes: false,
    };
  }
  return null;
}

// ─── Symbol Types ───────────────────────────────────────────

export interface ParsedSymbol {
  kind: "function" | "class" | "interface" | "method" | "code_element" | "struct" | "enum" | "trait" | "type_alias" | "namespace";
  name: string;
  startLine: number;
  endLine: number;
  params: string;
  signature: string;
  exported: boolean;
  exportDefault: boolean;
  decorators: string;
  isAbstract: boolean;
  visibility: string;
  isStatic: boolean;
  isAsync: boolean;
  isGenerator: boolean;
  elementType: string;
  className: string;
}

function createSymbol(overrides: Partial<ParsedSymbol> & { kind: ParsedSymbol["kind"]; name: string; startLine: number; endLine: number }): ParsedSymbol {
  return {
    params: "",
    signature: "",
    exported: false,
    exportDefault: false,
    decorators: "",
    isAbstract: false,
    visibility: "",
    isStatic: false,
    isAsync: false,
    isGenerator: false,
    elementType: "",
    className: "",
    ...overrides,
  };
}

// ─── AST Helpers ────────────────────────────────────────────

function getNodeText(node: SyntaxNode | null): string {
  return node?.text ?? "";
}

function extractDecorators(node: SyntaxNode): string[] {
  const decorators: string[] = [];
  for (const child of node.children) {
    if (child.type === "decorator") {
      const expr = child.namedChildren[0];
      if (expr) {
        if (expr.type === "call_expression") {
          const fn = expr.childForFieldName("function");
          if (fn) decorators.push(fn.text);
        } else {
          decorators.push(expr.text);
        }
      }
    }
  }
  return decorators;
}

function extractSignature(node: SyntaxNode): string {
  const body = node.childForFieldName("body");
  let sig: string;
  if (body) {
    const source = node.text;
    const bodyOffset = body.startIndex - node.startIndex;
    sig = source.substring(0, bodyOffset).trim();
  } else {
    sig = node.text.trim();
  }
  return sig.length > MAX_SIGNATURE_LENGTH
    ? sig.substring(0, MAX_SIGNATURE_LENGTH) + "..."
    : sig;
}

function extractParams(node: SyntaxNode): string {
  const params = node.childForFieldName("parameters");
  return params ? params.text : "";
}

function hasKeyword(node: SyntaxNode, keyword: string): boolean {
  for (const child of node.children) {
    if (!child.isNamed && child.text === keyword) {
      return true;
    }
  }
  return false;
}

function getAccessibility(node: SyntaxNode): string {
  for (const child of node.children) {
    if (child.type === "accessibility_modifier") {
      return child.text;
    }
  }
  return "";
}

// ─── Symbol Extractors ──────────────────────────────────────

function extractFunction(
  node: SyntaxNode,
  exported: boolean,
  exportDefault: boolean,
): ParsedSymbol {
  return createSymbol({
    kind: "function",
    name: getNodeText(node.childForFieldName("name")) || "(anonymous)",
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    params: extractParams(node),
    signature: extractSignature(node),
    exported,
    exportDefault,
    isAsync: hasKeyword(node, "async"),
    isGenerator: node.type === "generator_function_declaration",
  });
}

function extractArrowFunction(
  declaratorNode: SyntaxNode,
  arrowNode: SyntaxNode,
  exported: boolean,
  exportDefault: boolean,
): ParsedSymbol {
  return createSymbol({
    kind: "function",
    name: getNodeText(declaratorNode.childForFieldName("name")) || "(anonymous)",
    startLine: declaratorNode.startPosition.row + 1,
    endLine: declaratorNode.endPosition.row + 1,
    params: extractParams(arrowNode),
    signature: extractSignature(declaratorNode),
    exported,
    exportDefault,
    isAsync: hasKeyword(arrowNode, "async"),
  });
}

function extractClass(
  node: SyntaxNode,
  exported: boolean,
  exportDefault: boolean,
  parentDecorators: string[] = [],
): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];
  const name = getNodeText(node.childForFieldName("name")) || "(anonymous)";
  const isAbstract = node.type === "abstract_class_declaration";
  const classDecorators = [...parentDecorators, ...extractDecorators(node)];

  symbols.push(createSymbol({
    kind: "class",
    name,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: extractSignature(node),
    exported,
    exportDefault,
    decorators: classDecorators.join(","),
    isAbstract,
  }));

  // Extract members from class body
  const body = node.childForFieldName("body");
  if (body) {
    let pendingDecorators: string[] = [];

    for (const member of body.namedChildren) {
      if (member.type === "decorator") {
        // Collect decorators for the next member
        const expr = member.namedChildren[0];
        if (expr) {
          if (expr.type === "call_expression") {
            const fn = expr.childForFieldName("function");
            if (fn) pendingDecorators.push(fn.text);
          } else {
            pendingDecorators.push(expr.text);
          }
        }
        continue;
      }

      if (member.type === "method_definition") {
        symbols.push(extractMethod(member, name, pendingDecorators));
        pendingDecorators = [];
      } else if (member.type === "public_field_definition") {
        const value = member.childForFieldName("value");
        if (value && value.type === "arrow_function") {
          symbols.push(extractFieldArrowMethod(member, value, name, pendingDecorators));
        }
        pendingDecorators = [];
      } else if (member.type === "abstract_method_signature") {
        symbols.push(extractAbstractMethod(member, name, pendingDecorators));
        pendingDecorators = [];
      } else {
        // Reset decorators if we encounter an unknown member type
        pendingDecorators = [];
      }
    }
  }

  return symbols;
}

function extractMethod(
  node: SyntaxNode,
  className: string,
  decorators: string[] = [],
): ParsedSymbol {
  const methodName = getNodeText(node.childForFieldName("name"));
  return createSymbol({
    kind: "method",
    name: methodName || "(anonymous)",
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    params: extractParams(node),
    signature: extractSignature(node),
    decorators: decorators.join(","),
    isAbstract: hasKeyword(node, "abstract"),
    visibility: getAccessibility(node),
    isStatic: hasKeyword(node, "static"),
    isAsync: hasKeyword(node, "async"),
    className,
  });
}

function extractFieldArrowMethod(
  fieldNode: SyntaxNode,
  arrowNode: SyntaxNode,
  className: string,
  decorators: string[] = [],
): ParsedSymbol {
  const name = getNodeText(fieldNode.childForFieldName("name"));
  return createSymbol({
    kind: "method",
    name: name || "(anonymous)",
    startLine: fieldNode.startPosition.row + 1,
    endLine: fieldNode.endPosition.row + 1,
    params: extractParams(arrowNode),
    signature: extractSignature(fieldNode),
    decorators: decorators.join(","),
    visibility: getAccessibility(fieldNode),
    isStatic: hasKeyword(fieldNode, "static"),
    isAsync: hasKeyword(arrowNode, "async"),
    className,
  });
}

function extractAbstractMethod(
  node: SyntaxNode,
  className: string,
  decorators: string[] = [],
): ParsedSymbol {
  const name = getNodeText(node.childForFieldName("name"));
  return createSymbol({
    kind: "method",
    name: name || "(anonymous)",
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    params: extractParams(node),
    signature: node.text.trim(),
    decorators: decorators.join(","),
    isAbstract: true,
    visibility: getAccessibility(node),
    className,
  });
}

function extractInterface(
  node: SyntaxNode,
  exported: boolean,
  exportDefault: boolean,
): ParsedSymbol {
  return createSymbol({
    kind: "interface",
    name: getNodeText(node.childForFieldName("name")) || "(anonymous)",
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: extractSignature(node),
    exported,
    exportDefault,
  });
}

function extractEnum(
  node: SyntaxNode,
  exported: boolean,
  exportDefault: boolean,
): ParsedSymbol {
  const sig = node.text.split("{")[0]?.trim() ?? "";
  return createSymbol({
    kind: "enum",
    name: getNodeText(node.childForFieldName("name")) || "(anonymous)",
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: sig.length > MAX_SIGNATURE_LENGTH ? sig.substring(0, MAX_SIGNATURE_LENGTH) + "..." : sig,
    exported,
    exportDefault,
    elementType: "enum",
  });
}

function extractTypeAlias(
  node: SyntaxNode,
  exported: boolean,
  exportDefault: boolean,
): ParsedSymbol {
  const sig = node.text.trim();
  return createSymbol({
    kind: "type_alias",
    name: getNodeText(node.childForFieldName("name")) || "(anonymous)",
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: sig.length > MAX_SIGNATURE_LENGTH ? sig.substring(0, MAX_SIGNATURE_LENGTH) + "..." : sig,
    exported,
    exportDefault,
    elementType: "type_alias",
  });
}

function extractVariableDeclarations(
  node: SyntaxNode,
  exported: boolean,
  exportDefault: boolean,
): ParsedSymbol[] {
  const isConst = node.children.some((c) => !c.isNamed && c.text === "const");
  const symbols: ParsedSymbol[] = [];

  for (const child of node.namedChildren) {
    if (child.type !== "variable_declarator") continue;

    const nameNode = child.childForFieldName("name");
    if (!nameNode || nameNode.type !== "identifier") continue;

    const name = nameNode.text;
    const value = child.childForFieldName("value");

    if (
      value &&
      (value.type === "arrow_function" || value.type === "function_expression")
    ) {
      symbols.push(
        extractArrowFunction(child, value, exported, exportDefault),
      );
    } else if (isConst) {
      const sig = child.text.trim();
      symbols.push(createSymbol({
        kind: "code_element",
        name,
        startLine: child.startPosition.row + 1,
        endLine: child.endPosition.row + 1,
        signature: sig.length > MAX_SIGNATURE_LENGTH ? sig.substring(0, MAX_SIGNATURE_LENGTH) + "..." : sig,
        exported,
        exportDefault,
        elementType: "constant",
      }));
    }
  }

  return symbols;
}

// ─── Top-level Extraction ───────────────────────────────────

function extractSymbols(
  rootNode: SyntaxNode,
  supportsTypes: boolean,
): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];

  for (const child of rootNode.namedChildren) {
    switch (child.type) {
      case "export_statement": {
        const isDefault = child.children.some(
          (c) => !c.isNamed && c.text === "default",
        );
        const decorators = extractDecorators(child);

        for (const inner of child.namedChildren) {
          switch (inner.type) {
            case "function_declaration":
            case "generator_function_declaration":
              symbols.push(extractFunction(inner, true, isDefault));
              break;
            case "class_declaration":
            case "abstract_class_declaration":
              symbols.push(
                ...extractClass(inner, true, isDefault, decorators),
              );
              break;
            case "interface_declaration":
              if (supportsTypes) {
                symbols.push(extractInterface(inner, true, isDefault));
              }
              break;
            case "type_alias_declaration":
              if (supportsTypes) {
                symbols.push(extractTypeAlias(inner, true, isDefault));
              }
              break;
            case "enum_declaration":
              if (supportsTypes) {
                symbols.push(extractEnum(inner, true, isDefault));
              }
              break;
            case "lexical_declaration":
              symbols.push(
                ...extractVariableDeclarations(inner, true, isDefault),
              );
              break;
          }
        }
        break;
      }

      case "function_declaration":
      case "generator_function_declaration":
        symbols.push(extractFunction(child, false, false));
        break;

      case "class_declaration":
      case "abstract_class_declaration":
        symbols.push(...extractClass(child, false, false));
        break;

      case "interface_declaration":
        if (supportsTypes) {
          symbols.push(extractInterface(child, false, false));
        }
        break;

      case "type_alias_declaration":
        if (supportsTypes) {
          symbols.push(extractTypeAlias(child, false, false));
        }
        break;

      case "enum_declaration":
        if (supportsTypes) {
          symbols.push(extractEnum(child, false, false));
        }
        break;

      case "lexical_declaration":
        symbols.push(
          ...extractVariableDeclarations(child, false, false),
        );
        break;
    }
  }

  return symbols;
}

// ─── Python Symbol Extraction ───────────────────────────────

function extractPythonDecorators(node: SyntaxNode): string[] {
  const decorators: string[] = [];
  for (const child of node.children) {
    if (child.type === "decorator") {
      // Decorator children: "@" + (identifier | call | attribute)
      const expr = child.namedChildren[0];
      if (expr) {
        if (expr.type === "call") {
          const fn = expr.childForFieldName("function");
          if (fn) decorators.push(fn.text);
        } else {
          decorators.push(expr.text);
        }
      }
    }
  }
  return decorators;
}

function extractPythonSignature(node: SyntaxNode): string {
  const body = node.childForFieldName("body");
  let sig: string;
  if (body) {
    const source = node.text;
    const bodyOffset = body.startIndex - node.startIndex;
    sig = source.substring(0, bodyOffset).trim();
    // Remove trailing colon
    if (sig.endsWith(":")) sig = sig.slice(0, -1).trim();
  } else {
    sig = node.text.trim();
  }
  return sig.length > MAX_SIGNATURE_LENGTH
    ? sig.substring(0, MAX_SIGNATURE_LENGTH) + "..."
    : sig;
}

function isPythonUpperCase(name: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(name);
}

function extractPythonFunction(
  node: SyntaxNode,
  decorators: string[],
): ParsedSymbol {
  const isAsync = node.children.some(
    (c) => !c.isNamed && c.text === "async",
  );
  return createSymbol({
    kind: "function",
    name: getNodeText(node.childForFieldName("name")) || "(anonymous)",
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    params: extractParams(node),
    signature: extractPythonSignature(node),
    exported: true, // Python module-level = exported
    decorators: decorators.join(","),
    isAsync,
  });
}

function extractPythonMethod(
  node: SyntaxNode,
  className: string,
  decorators: string[],
): ParsedSymbol {
  const isAsync = node.children.some(
    (c) => !c.isNamed && c.text === "async",
  );
  const isStatic = decorators.includes("staticmethod");
  const isClassMethod = decorators.includes("classmethod");
  const isProperty = decorators.includes("property");

  let elementType = "";
  if (isProperty) elementType = "property";
  else if (isClassMethod) elementType = "classmethod";

  return createSymbol({
    kind: "method",
    name: getNodeText(node.childForFieldName("name")) || "(anonymous)",
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    params: extractParams(node),
    signature: extractPythonSignature(node),
    decorators: decorators.join(","),
    isStatic,
    isAsync,
    className,
    elementType,
  });
}

function extractPythonClass(
  node: SyntaxNode,
  decorators: string[],
): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];
  const className = getNodeText(node.childForFieldName("name")) || "(anonymous)";

  symbols.push(createSymbol({
    kind: "class",
    name: className,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: extractPythonSignature(node),
    exported: true,
    decorators: decorators.join(","),
  }));

  // Extract methods from class body
  const body = node.childForFieldName("body");
  if (body) {
    for (const member of body.namedChildren) {
      if (member.type === "function_definition") {
        symbols.push(extractPythonMethod(member, className, []));
      } else if (member.type === "decorated_definition") {
        const methodDecorators = extractPythonDecorators(member);
        const definition = member.childForFieldName("definition");
        if (definition && definition.type === "function_definition") {
          symbols.push(
            extractPythonMethod(definition, className, methodDecorators),
          );
        }
      } else if (member.type === "expression_statement") {
        // Class-level constant assignments (e.g., CLASS_CONST = 42)
        const assignment = member.namedChildren[0];
        if (assignment?.type === "assignment") {
          const left = assignment.childForFieldName("left");
          if (left?.type === "identifier" && isPythonUpperCase(left.text)) {
            const sig = assignment.text.trim();
            symbols.push(createSymbol({
              kind: "code_element",
              name: left.text,
              startLine: member.startPosition.row + 1,
              endLine: member.endPosition.row + 1,
              signature: sig.length > MAX_SIGNATURE_LENGTH
                ? sig.substring(0, MAX_SIGNATURE_LENGTH) + "..."
                : sig,
              exported: true,
              elementType: "constant",
              className,
            }));
          }
        }
      }
    }
  }

  return symbols;
}

function extractPythonSymbols(rootNode: SyntaxNode): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];

  for (const child of rootNode.namedChildren) {
    switch (child.type) {
      case "function_definition":
        symbols.push(extractPythonFunction(child, []));
        break;

      case "class_definition":
        symbols.push(...extractPythonClass(child, []));
        break;

      case "decorated_definition": {
        const decorators = extractPythonDecorators(child);
        const definition = child.childForFieldName("definition");
        if (definition) {
          if (definition.type === "function_definition") {
            symbols.push(extractPythonFunction(definition, decorators));
          } else if (definition.type === "class_definition") {
            symbols.push(...extractPythonClass(definition, decorators));
          }
        }
        break;
      }

      case "expression_statement": {
        // Module-level constant assignments (e.g., MAX_SIZE = 100)
        const assignment = child.namedChildren[0];
        if (assignment?.type === "assignment") {
          const left = assignment.childForFieldName("left");
          if (left?.type === "identifier" && isPythonUpperCase(left.text)) {
            const sig = assignment.text.trim();
            symbols.push(createSymbol({
              kind: "code_element",
              name: left.text,
              startLine: child.startPosition.row + 1,
              endLine: child.endPosition.row + 1,
              signature: sig.length > MAX_SIGNATURE_LENGTH
                ? sig.substring(0, MAX_SIGNATURE_LENGTH) + "..."
                : sig,
              exported: true,
              elementType: "constant",
            }));
          }
        }
        break;
      }
    }
  }

  return symbols;
}

// ─── Rust Symbol Extraction ─────────────────────────────────

function hasRustVisibility(node: SyntaxNode): boolean {
  return node.children.some((c) => c.type === "visibility_modifier");
}

function getRustVisibility(node: SyntaxNode): string {
  for (const child of node.children) {
    if (child.type === "visibility_modifier") {
      return child.text; // "pub", "pub(crate)", "pub(super)", etc.
    }
  }
  return "";
}

function isRustAsync(node: SyntaxNode): boolean {
  return node.children.some(
    (c) => c.type === "function_modifiers" && c.text.includes("async"),
  );
}

function extractRustSignature(node: SyntaxNode): string {
  const body = node.childForFieldName("body");
  let sig: string;
  if (body) {
    const source = node.text;
    const bodyOffset = body.startIndex - node.startIndex;
    sig = source.substring(0, bodyOffset).trim();
  } else {
    sig = node.text.trim();
  }
  // Remove trailing semicolons for signatures without bodies
  if (sig.endsWith(";")) sig = sig.slice(0, -1).trim();
  return sig.length > MAX_SIGNATURE_LENGTH
    ? sig.substring(0, MAX_SIGNATURE_LENGTH) + "..."
    : sig;
}

function extractRustFunction(
  node: SyntaxNode,
): ParsedSymbol {
  const isPub = hasRustVisibility(node);
  return createSymbol({
    kind: "function",
    name: getNodeText(node.childForFieldName("name")) || "(anonymous)",
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    params: extractParams(node),
    signature: extractRustSignature(node),
    exported: isPub,
    isAsync: isRustAsync(node),
    visibility: getRustVisibility(node),
  });
}

function extractRustStruct(
  node: SyntaxNode,
): ParsedSymbol {
  const isPub = hasRustVisibility(node);
  return createSymbol({
    kind: "struct",
    name: getNodeText(node.childForFieldName("name")) || "(anonymous)",
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: extractRustSignature(node),
    exported: isPub,
    elementType: "struct",
    visibility: getRustVisibility(node),
  });
}

function extractRustEnum(
  node: SyntaxNode,
): ParsedSymbol {
  const isPub = hasRustVisibility(node);
  return createSymbol({
    kind: "enum",
    name: getNodeText(node.childForFieldName("name")) || "(anonymous)",
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: extractRustSignature(node),
    exported: isPub,
    elementType: "enum",
    visibility: getRustVisibility(node),
  });
}

function extractRustTrait(
  node: SyntaxNode,
): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];
  const isPub = hasRustVisibility(node);
  const traitName = getNodeText(node.childForFieldName("name")) || "(anonymous)";

  symbols.push(createSymbol({
    kind: "trait",
    name: traitName,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: extractRustSignature(node),
    exported: isPub,
    visibility: getRustVisibility(node),
  }));

  // Extract trait method signatures
  const body = node.childForFieldName("body");
  if (body) {
    for (const member of body.namedChildren) {
      if (member.type === "function_signature_item") {
        symbols.push(createSymbol({
          kind: "method",
          name: getNodeText(member.childForFieldName("name")) || "(anonymous)",
          startLine: member.startPosition.row + 1,
          endLine: member.endPosition.row + 1,
          params: extractParams(member),
          signature: extractRustSignature(member),
          isAbstract: true,
          className: traitName,
        }));
      } else if (member.type === "function_item") {
        // Default method implementation in trait
        symbols.push(createSymbol({
          kind: "method",
          name: getNodeText(member.childForFieldName("name")) || "(anonymous)",
          startLine: member.startPosition.row + 1,
          endLine: member.endPosition.row + 1,
          params: extractParams(member),
          signature: extractRustSignature(member),
          isAsync: isRustAsync(member),
          className: traitName,
        }));
      }
    }
  }

  return symbols;
}

function extractRustImpl(
  node: SyntaxNode,
): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];

  // Determine the impl target type and optional trait
  const typeNode = node.childForFieldName("type");
  const traitNode = node.childForFieldName("trait");
  const typeName = typeNode ? typeNode.text : "(unknown)";
  const traitName = traitNode ? traitNode.text : "";

  // className for methods: "TypeName" for inherent impls, "Trait for TypeName" for trait impls
  const className = traitName ? `${traitName} for ${typeName}` : typeName;

  // Extract methods from impl body
  const body = node.childForFieldName("body");
  if (body) {
    for (const member of body.namedChildren) {
      if (member.type === "function_item") {
        const isPub = hasRustVisibility(member);
        symbols.push(createSymbol({
          kind: "method",
          name: getNodeText(member.childForFieldName("name")) || "(anonymous)",
          startLine: member.startPosition.row + 1,
          endLine: member.endPosition.row + 1,
          params: extractParams(member),
          signature: extractRustSignature(member),
          exported: isPub,
          isAsync: isRustAsync(member),
          visibility: getRustVisibility(member),
          className,
        }));
      }
    }
  }

  return symbols;
}

function extractRustConst(
  node: SyntaxNode,
): ParsedSymbol {
  const isPub = hasRustVisibility(node);
  const sig = node.text.trim();
  return createSymbol({
    kind: "code_element",
    name: getNodeText(node.childForFieldName("name")) || "(anonymous)",
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: sig.length > MAX_SIGNATURE_LENGTH
      ? sig.substring(0, MAX_SIGNATURE_LENGTH) + "..."
      : sig,
    exported: isPub,
    elementType: "constant",
    visibility: getRustVisibility(node),
  });
}

function extractRustTypeAlias(
  node: SyntaxNode,
): ParsedSymbol {
  const isPub = hasRustVisibility(node);
  const sig = node.text.trim();
  return createSymbol({
    kind: "type_alias",
    name: getNodeText(node.childForFieldName("name")) || "(anonymous)",
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: sig.length > MAX_SIGNATURE_LENGTH
      ? sig.substring(0, MAX_SIGNATURE_LENGTH) + "..."
      : sig,
    exported: isPub,
    elementType: "type_alias",
    visibility: getRustVisibility(node),
  });
}

function extractRustStatic(
  node: SyntaxNode,
): ParsedSymbol {
  const isPub = hasRustVisibility(node);
  const sig = node.text.trim();
  return createSymbol({
    kind: "code_element",
    name: getNodeText(node.childForFieldName("name")) || "(anonymous)",
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: sig.length > MAX_SIGNATURE_LENGTH
      ? sig.substring(0, MAX_SIGNATURE_LENGTH) + "..."
      : sig,
    exported: isPub,
    elementType: "static",
    visibility: getRustVisibility(node),
  });
}

function extractRustSymbols(rootNode: SyntaxNode): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];

  for (const child of rootNode.namedChildren) {
    switch (child.type) {
      case "function_item":
        symbols.push(extractRustFunction(child));
        break;

      case "struct_item":
        symbols.push(extractRustStruct(child));
        break;

      case "enum_item":
        symbols.push(extractRustEnum(child));
        break;

      case "trait_item":
        symbols.push(...extractRustTrait(child));
        break;

      case "impl_item":
        symbols.push(...extractRustImpl(child));
        break;

      case "const_item":
        symbols.push(extractRustConst(child));
        break;

      case "type_item":
        symbols.push(extractRustTypeAlias(child));
        break;

      case "static_item":
        symbols.push(extractRustStatic(child));
        break;
    }
  }

  return symbols;
}

// ─── Go Symbol Extraction ───────────────────────────────────

function isGoExported(name: string): boolean {
  return name.length > 0 && name[0] >= "A" && name[0] <= "Z";
}

function extractGoSignature(node: SyntaxNode): string {
  const body = node.childForFieldName("body");
  let sig: string;
  if (body) {
    const source = node.text;
    const bodyOffset = body.startIndex - node.startIndex;
    sig = source.substring(0, bodyOffset).trim();
  } else {
    sig = node.text.trim();
  }
  return sig.length > MAX_SIGNATURE_LENGTH
    ? sig.substring(0, MAX_SIGNATURE_LENGTH) + "..."
    : sig;
}

function extractGoFunction(node: SyntaxNode): ParsedSymbol {
  const name = getNodeText(node.childForFieldName("name")) || "(anonymous)";
  return createSymbol({
    kind: "function",
    name,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    params: extractParams(node),
    signature: extractGoSignature(node),
    exported: isGoExported(name),
  });
}

function extractGoMethod(node: SyntaxNode): ParsedSymbol {
  const name = getNodeText(node.childForFieldName("name")) || "(anonymous)";

  // Extract receiver type for className
  const receiver = node.childForFieldName("receiver");
  let receiverType = "";
  if (receiver) {
    // receiver is a parameter_list, find the parameter_declaration inside
    for (const child of receiver.namedChildren) {
      if (child.type === "parameter_declaration") {
        const typeNode = child.childForFieldName("type");
        if (typeNode) {
          // Strip pointer: "*User" → "User"
          receiverType = typeNode.text.replace(/^\*/, "");
        }
      }
    }
  }

  return createSymbol({
    kind: "method",
    name,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    params: extractParams(node),
    signature: extractGoSignature(node),
    exported: isGoExported(name),
    className: receiverType,
  });
}

function extractGoStruct(
  nameNode: SyntaxNode,
  specNode: SyntaxNode,
): ParsedSymbol {
  const name = nameNode.text;
  const sig = specNode.parent ? specNode.parent.text.trim() : specNode.text.trim();
  return createSymbol({
    kind: "struct",
    name,
    startLine: (specNode.parent ?? specNode).startPosition.row + 1,
    endLine: (specNode.parent ?? specNode).endPosition.row + 1,
    signature: sig.length > MAX_SIGNATURE_LENGTH
      ? sig.substring(0, MAX_SIGNATURE_LENGTH) + "..."
      : sig,
    exported: isGoExported(name),
    elementType: "struct",
  });
}

function extractGoInterface(
  nameNode: SyntaxNode,
  typeNode: SyntaxNode,
  parentNode: SyntaxNode,
): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];
  const name = nameNode.text;
  const sig = parentNode.text.trim();

  symbols.push(createSymbol({
    kind: "interface",
    name,
    startLine: parentNode.startPosition.row + 1,
    endLine: parentNode.endPosition.row + 1,
    signature: sig.length > MAX_SIGNATURE_LENGTH
      ? sig.substring(0, MAX_SIGNATURE_LENGTH) + "..."
      : sig,
    exported: isGoExported(name),
  }));

  // Extract interface method signatures (method_elem nodes)
  for (const child of typeNode.namedChildren) {
    if (child.type === "method_elem") {
      const methodName = getNodeText(child.childForFieldName("name"));
      if (methodName) {
        symbols.push(createSymbol({
          kind: "method",
          name: methodName,
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
          params: extractParams(child),
          signature: child.text.trim(),
          isAbstract: true,
          className: name,
        }));
      }
    }
  }

  return symbols;
}

function extractGoConstDecl(node: SyntaxNode): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];

  for (const child of node.namedChildren) {
    if (child.type === "const_spec") {
      const nameNode = child.childForFieldName("name");
      if (nameNode) {
        const name = nameNode.text;
        const sig = child.text.trim();
        symbols.push(createSymbol({
          kind: "code_element",
          name,
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
          signature: sig.length > MAX_SIGNATURE_LENGTH
            ? sig.substring(0, MAX_SIGNATURE_LENGTH) + "..."
            : sig,
          exported: isGoExported(name),
          elementType: "constant",
        }));
      }
    }
  }

  return symbols;
}

function extractGoTypeDecl(node: SyntaxNode): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];

  for (const child of node.namedChildren) {
    if (child.type === "type_spec") {
      const nameNode = child.childForFieldName("name");
      const typeNode = child.childForFieldName("type");
      if (!nameNode) continue;

      if (typeNode?.type === "struct_type") {
        symbols.push(extractGoStruct(nameNode, child));
      } else if (typeNode?.type === "interface_type") {
        symbols.push(...extractGoInterface(nameNode, typeNode, node));
      } else {
        // Regular type declaration (e.g., type UserID int64)
        const name = nameNode.text;
        const sig = node.text.trim();
        symbols.push(createSymbol({
          kind: "type_alias",
          name,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          signature: sig.length > MAX_SIGNATURE_LENGTH
            ? sig.substring(0, MAX_SIGNATURE_LENGTH) + "..."
            : sig,
          exported: isGoExported(name),
          elementType: "type_alias",
        }));
      }
    } else if (child.type === "type_alias") {
      // Actual Go type alias: type X = Y
      const nameNode = child.childForFieldName("name");
      if (nameNode) {
        const name = nameNode.text;
        const sig = node.text.trim();
        symbols.push(createSymbol({
          kind: "type_alias",
          name,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          signature: sig.length > MAX_SIGNATURE_LENGTH
            ? sig.substring(0, MAX_SIGNATURE_LENGTH) + "..."
            : sig,
          exported: isGoExported(name),
          elementType: "type_alias",
        }));
      }
    }
  }

  return symbols;
}

function extractGoSymbols(rootNode: SyntaxNode): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];

  for (const child of rootNode.namedChildren) {
    switch (child.type) {
      case "function_declaration":
        symbols.push(extractGoFunction(child));
        break;

      case "method_declaration":
        symbols.push(extractGoMethod(child));
        break;

      case "const_declaration":
        symbols.push(...extractGoConstDecl(child));
        break;

      case "type_declaration":
        symbols.push(...extractGoTypeDecl(child));
        break;
    }
  }

  return symbols;
}

// ─── Java Symbol Extraction ─────────────────────────────────

function findJavaModifiers(node: SyntaxNode): SyntaxNode | null {
  return node.children.find((c) => c.type === "modifiers") ?? null;
}

function getJavaVisibility(node: SyntaxNode): string {
  const modifiers = findJavaModifiers(node);
  if (!modifiers) return "";
  for (const child of modifiers.children) {
    if (!child.isNamed && (child.text === "public" || child.text === "private" || child.text === "protected")) {
      return child.text;
    }
  }
  return "";
}

function hasJavaModifier(node: SyntaxNode, modifier: string): boolean {
  const modifiers = findJavaModifiers(node);
  if (!modifiers) return false;
  return modifiers.children.some((c) => !c.isNamed && c.text === modifier);
}

function extractJavaAnnotations(node: SyntaxNode): string[] {
  const modifiers = findJavaModifiers(node);
  if (!modifiers) return [];
  const annotations: string[] = [];
  for (const child of modifiers.namedChildren) {
    if (child.type === "marker_annotation") {
      const name = child.childForFieldName("name");
      if (name) annotations.push(name.text);
    } else if (child.type === "annotation") {
      const name = child.childForFieldName("name");
      if (name) annotations.push(name.text);
    }
  }
  return annotations;
}

function extractJavaSignature(node: SyntaxNode): string {
  const body = node.childForFieldName("body");
  let sig: string;
  if (body) {
    const source = node.text;
    const bodyOffset = body.startIndex - node.startIndex;
    sig = source.substring(0, bodyOffset).trim();
  } else {
    sig = node.text.trim();
    // Remove trailing semicolons for abstract method signatures
    if (sig.endsWith(";")) sig = sig.slice(0, -1).trim();
  }
  return sig.length > MAX_SIGNATURE_LENGTH
    ? sig.substring(0, MAX_SIGNATURE_LENGTH) + "..."
    : sig;
}

function extractJavaMethod(
  node: SyntaxNode,
  className: string,
): ParsedSymbol {
  const name = getNodeText(node.childForFieldName("name")) || "(anonymous)";
  const hasBody = !!node.childForFieldName("body");
  return createSymbol({
    kind: "method",
    name,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    params: extractParams(node),
    signature: extractJavaSignature(node),
    decorators: extractJavaAnnotations(node).join(","),
    isAbstract: hasJavaModifier(node, "abstract") || (!hasBody && !hasJavaModifier(node, "default") && !hasJavaModifier(node, "native")),
    visibility: getJavaVisibility(node),
    isStatic: hasJavaModifier(node, "static"),
    className,
  });
}

function extractJavaConstructor(
  node: SyntaxNode,
  className: string,
): ParsedSymbol {
  return createSymbol({
    kind: "method",
    name: getNodeText(node.childForFieldName("name")) || className,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    params: extractParams(node),
    signature: extractJavaSignature(node),
    decorators: extractJavaAnnotations(node).join(","),
    visibility: getJavaVisibility(node),
    className,
    elementType: "constructor",
  });
}

function extractJavaField(
  node: SyntaxNode,
  className: string,
): ParsedSymbol | null {
  const declarator = node.childForFieldName("declarator");
  if (!declarator) return null;
  const nameNode = declarator.childForFieldName("name");
  if (!nameNode) return null;
  const isFinal = hasJavaModifier(node, "final");
  const isStatic = hasJavaModifier(node, "static");
  const sig = node.text.trim();
  return createSymbol({
    kind: "code_element",
    name: nameNode.text,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: sig.endsWith(";") ? sig.slice(0, -1).trim() : sig,
    decorators: extractJavaAnnotations(node).join(","),
    visibility: getJavaVisibility(node),
    isStatic,
    exported: getJavaVisibility(node) === "public",
    elementType: isFinal && isStatic ? "constant" : "field",
    className,
  });
}

function extractJavaClass(
  node: SyntaxNode,
): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];
  const className = getNodeText(node.childForFieldName("name")) || "(anonymous)";
  const isPublic = getJavaVisibility(node) === "public";
  const isAbstract = hasJavaModifier(node, "abstract");

  symbols.push(createSymbol({
    kind: "class",
    name: className,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: extractJavaSignature(node),
    exported: isPublic,
    decorators: extractJavaAnnotations(node).join(","),
    isAbstract,
    visibility: getJavaVisibility(node),
  }));

  // Extract members from class body
  const body = node.childForFieldName("body");
  if (body) {
    for (const member of body.namedChildren) {
      if (member.type === "method_declaration") {
        symbols.push(extractJavaMethod(member, className));
      } else if (member.type === "constructor_declaration") {
        symbols.push(extractJavaConstructor(member, className));
      } else if (member.type === "field_declaration") {
        const field = extractJavaField(member, className);
        if (field) symbols.push(field);
      } else if (member.type === "class_declaration") {
        // Inner class — extract recursively
        symbols.push(...extractJavaClass(member));
      } else if (member.type === "interface_declaration") {
        symbols.push(...extractJavaInterface(member));
      } else if (member.type === "enum_declaration") {
        symbols.push(...extractJavaEnum(member));
      } else if (member.type === "record_declaration") {
        symbols.push(...extractJavaRecord(member));
      }
    }
  }

  return symbols;
}

function extractJavaInterface(
  node: SyntaxNode,
): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];
  const name = getNodeText(node.childForFieldName("name")) || "(anonymous)";
  const isPublic = getJavaVisibility(node) === "public";

  symbols.push(createSymbol({
    kind: "interface",
    name,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: extractJavaSignature(node),
    exported: isPublic,
    visibility: getJavaVisibility(node),
  }));

  // Extract method signatures from interface body
  const body = node.childForFieldName("body");
  if (body) {
    for (const member of body.namedChildren) {
      if (member.type === "method_declaration") {
        symbols.push(extractJavaMethod(member, name));
      } else if (member.type === "constant_declaration") {
        // Interface constants (public static final by default)
        const declarator = member.childForFieldName("declarator");
        if (declarator) {
          const nameNode = declarator.childForFieldName("name");
          if (nameNode) {
            const sig = member.text.trim();
            symbols.push(createSymbol({
              kind: "code_element",
              name: nameNode.text,
              startLine: member.startPosition.row + 1,
              endLine: member.endPosition.row + 1,
              signature: sig.endsWith(";") ? sig.slice(0, -1).trim() : sig,
              exported: true,
              elementType: "constant",
              className: name,
            }));
          }
        }
      }
    }
  }

  return symbols;
}

function extractJavaEnum(
  node: SyntaxNode,
): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];
  const name = getNodeText(node.childForFieldName("name")) || "(anonymous)";
  const isPublic = getJavaVisibility(node) === "public";

  symbols.push(createSymbol({
    kind: "enum",
    name,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: extractJavaSignature(node),
    exported: isPublic,
    elementType: "enum",
    visibility: getJavaVisibility(node),
  }));

  // Extract methods from enum body declarations
  const body = node.childForFieldName("body");
  if (body) {
    for (const child of body.namedChildren) {
      if (child.type === "enum_body_declarations") {
        for (const member of child.namedChildren) {
          if (member.type === "method_declaration") {
            symbols.push(extractJavaMethod(member, name));
          } else if (member.type === "constructor_declaration") {
            symbols.push(extractJavaConstructor(member, name));
          } else if (member.type === "field_declaration") {
            const field = extractJavaField(member, name);
            if (field) symbols.push(field);
          }
        }
      }
    }
  }

  return symbols;
}

function extractJavaAnnotationType(
  node: SyntaxNode,
): ParsedSymbol {
  const name = getNodeText(node.childForFieldName("name")) || "(anonymous)";
  const isPublic = getJavaVisibility(node) === "public";
  return createSymbol({
    kind: "interface",
    name,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: extractJavaSignature(node),
    exported: isPublic,
    elementType: "annotation",
    visibility: getJavaVisibility(node),
  });
}

function extractJavaRecord(
  node: SyntaxNode,
): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];
  const name = getNodeText(node.childForFieldName("name")) || "(anonymous)";
  const isPublic = getJavaVisibility(node) === "public";

  symbols.push(createSymbol({
    kind: "class",
    name,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    params: extractParams(node),
    signature: extractJavaSignature(node),
    exported: isPublic,
    elementType: "record",
    visibility: getJavaVisibility(node),
  }));

  // Extract methods from record body
  const body = node.childForFieldName("body");
  if (body) {
    for (const member of body.namedChildren) {
      if (member.type === "method_declaration") {
        symbols.push(extractJavaMethod(member, name));
      } else if (member.type === "constructor_declaration") {
        symbols.push(extractJavaConstructor(member, name));
      }
    }
  }

  return symbols;
}

function extractJavaSymbols(rootNode: SyntaxNode): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];

  for (const child of rootNode.namedChildren) {
    switch (child.type) {
      case "class_declaration":
        symbols.push(...extractJavaClass(child));
        break;

      case "interface_declaration":
        symbols.push(...extractJavaInterface(child));
        break;

      case "enum_declaration":
        symbols.push(...extractJavaEnum(child));
        break;

      case "annotation_type_declaration":
        symbols.push(extractJavaAnnotationType(child));
        break;

      case "record_declaration":
        symbols.push(...extractJavaRecord(child));
        break;
    }
  }

  return symbols;
}

// ─── C# Symbol Extraction ───────────────────────────────────

function getCSharpVisibility(node: SyntaxNode): string {
  for (const child of node.children) {
    if (child.type === "modifier") {
      if (child.text === "public" || child.text === "private" || child.text === "protected" || child.text === "internal") {
        return child.text;
      }
    }
  }
  return "";
}

function hasCSharpModifier(node: SyntaxNode, modifier: string): boolean {
  return node.children.some((c) => c.type === "modifier" && c.text === modifier);
}

function extractCSharpAttributes(node: SyntaxNode): string[] {
  const attrs: string[] = [];
  for (const child of node.children) {
    if (child.type === "attribute_list") {
      for (const attr of child.namedChildren) {
        if (attr.type === "attribute") {
          const name = attr.childForFieldName("name");
          if (name) attrs.push(name.text);
        }
      }
    }
  }
  return attrs;
}

function extractCSharpSignature(node: SyntaxNode): string {
  // For methods/properties/classes: text before the body
  const body =
    node.childForFieldName("body") ??
    node.children.find((c) => c.type === "declaration_list" || c.type === "block" || c.type === "arrow_expression_clause");
  let sig: string;
  if (body) {
    const source = node.text;
    const bodyOffset = body.startIndex - node.startIndex;
    sig = source.substring(0, bodyOffset).trim();
  } else {
    sig = node.text.trim();
    if (sig.endsWith(";")) sig = sig.slice(0, -1).trim();
  }
  return sig.length > MAX_SIGNATURE_LENGTH
    ? sig.substring(0, MAX_SIGNATURE_LENGTH) + "..."
    : sig;
}

function extractCSharpMethod(
  node: SyntaxNode,
  className: string,
): ParsedSymbol {
  const name = getNodeText(node.childForFieldName("name")) || "(anonymous)";
  const hasBody = !!(node.childForFieldName("body") || node.children.find((c) => c.type === "arrow_expression_clause"));
  return createSymbol({
    kind: "method",
    name,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    params: extractParams(node),
    signature: extractCSharpSignature(node),
    decorators: extractCSharpAttributes(node).join(","),
    isAbstract: hasCSharpModifier(node, "abstract") || !hasBody,
    visibility: getCSharpVisibility(node),
    isStatic: hasCSharpModifier(node, "static"),
    isAsync: hasCSharpModifier(node, "async"),
    className,
  });
}

function extractCSharpProperty(
  node: SyntaxNode,
  className: string,
): ParsedSymbol {
  const name = getNodeText(node.childForFieldName("name")) || "(anonymous)";
  const sig = node.text.trim();
  return createSymbol({
    kind: "code_element",
    name,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: sig.length > MAX_SIGNATURE_LENGTH
      ? sig.substring(0, MAX_SIGNATURE_LENGTH) + "..."
      : sig,
    visibility: getCSharpVisibility(node),
    isStatic: hasCSharpModifier(node, "static"),
    isAbstract: hasCSharpModifier(node, "abstract"),
    elementType: "property",
    className,
    exported: getCSharpVisibility(node) === "public",
  });
}

function extractCSharpField(
  node: SyntaxNode,
  className: string,
): ParsedSymbol | null {
  // field_declaration → variable_declaration → variable_declarator
  const varDecl = node.children.find((c) => c.type === "variable_declaration");
  if (!varDecl) return null;
  const declarator = varDecl.namedChildren.find((c) => c.type === "variable_declarator");
  if (!declarator) return null;
  const nameNode = declarator.childForFieldName("name");
  if (!nameNode) return null;
  const isConst = hasCSharpModifier(node, "const");
  const sig = node.text.trim();
  return createSymbol({
    kind: "code_element",
    name: nameNode.text,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: sig.endsWith(";") ? sig.slice(0, -1).trim() : sig,
    visibility: getCSharpVisibility(node),
    isStatic: hasCSharpModifier(node, "static") || isConst,
    exported: getCSharpVisibility(node) === "public",
    elementType: isConst ? "constant" : "field",
    className,
  });
}

function extractCSharpClassLike(
  node: SyntaxNode,
  kind: "class" | "interface",
): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];
  const name = getNodeText(node.childForFieldName("name")) || "(anonymous)";
  const isPublic = getCSharpVisibility(node) === "public";
  const isAbstract = hasCSharpModifier(node, "abstract");

  symbols.push(createSymbol({
    kind,
    name,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: extractCSharpSignature(node),
    exported: isPublic,
    isAbstract,
    visibility: getCSharpVisibility(node),
    decorators: extractCSharpAttributes(node).join(","),
  }));

  // Extract members from declaration_list
  const body = node.children.find((c) => c.type === "declaration_list");
  if (body) {
    for (const member of body.namedChildren) {
      switch (member.type) {
        case "method_declaration":
        case "constructor_declaration":
          symbols.push(extractCSharpMethod(member, name));
          break;
        case "property_declaration":
          symbols.push(extractCSharpProperty(member, name));
          break;
        case "field_declaration":
          {
            const field = extractCSharpField(member, name);
            if (field) symbols.push(field);
          }
          break;
        case "class_declaration":
          symbols.push(...extractCSharpClassLike(member, "class"));
          break;
        case "interface_declaration":
          symbols.push(...extractCSharpClassLike(member, "interface"));
          break;
        case "struct_declaration":
          symbols.push(...extractCSharpStruct(member));
          break;
        case "enum_declaration":
          symbols.push(extractCSharpEnum(member));
          break;
      }
    }
  }

  return symbols;
}

function extractCSharpStruct(node: SyntaxNode): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];
  const name = getNodeText(node.childForFieldName("name")) || "(anonymous)";
  const isPublic = getCSharpVisibility(node) === "public";

  symbols.push(createSymbol({
    kind: "struct",
    name,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: extractCSharpSignature(node),
    exported: isPublic,
    visibility: getCSharpVisibility(node),
    elementType: "struct",
  }));

  const body = node.children.find((c) => c.type === "declaration_list");
  if (body) {
    for (const member of body.namedChildren) {
      switch (member.type) {
        case "method_declaration":
        case "constructor_declaration":
          symbols.push(extractCSharpMethod(member, name));
          break;
        case "property_declaration":
          symbols.push(extractCSharpProperty(member, name));
          break;
        case "field_declaration":
          {
            const field = extractCSharpField(member, name);
            if (field) symbols.push(field);
          }
          break;
      }
    }
  }

  return symbols;
}

function extractCSharpEnum(node: SyntaxNode): ParsedSymbol {
  const name = getNodeText(node.childForFieldName("name")) || "(anonymous)";
  const isPublic = getCSharpVisibility(node) === "public";
  return createSymbol({
    kind: "enum",
    name,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: extractCSharpSignature(node),
    exported: isPublic,
    elementType: "enum",
    visibility: getCSharpVisibility(node),
  });
}

function extractCSharpDelegate(node: SyntaxNode): ParsedSymbol {
  const name = getNodeText(node.childForFieldName("name")) || "(anonymous)";
  const isPublic = getCSharpVisibility(node) === "public";
  const sig = node.text.trim();
  return createSymbol({
    kind: "code_element",
    name,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: sig.endsWith(";") ? sig.slice(0, -1).trim() : sig,
    exported: isPublic,
    elementType: "delegate",
    visibility: getCSharpVisibility(node),
    params: extractParams(node),
  });
}

function extractCSharpDeclarationList(node: SyntaxNode): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];

  for (const child of node.namedChildren) {
    switch (child.type) {
      case "class_declaration":
        symbols.push(...extractCSharpClassLike(child, "class"));
        break;
      case "interface_declaration":
        symbols.push(...extractCSharpClassLike(child, "interface"));
        break;
      case "struct_declaration":
        symbols.push(...extractCSharpStruct(child));
        break;
      case "enum_declaration":
        symbols.push(extractCSharpEnum(child));
        break;
      case "delegate_declaration":
        symbols.push(extractCSharpDelegate(child));
        break;
      case "namespace_declaration": {
        // Recurse into nested namespaces
        const body = child.children.find((c) => c.type === "declaration_list");
        if (body) symbols.push(...extractCSharpDeclarationList(body));
        break;
      }
    }
  }

  return symbols;
}

function extractCSharpSymbols(rootNode: SyntaxNode): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];

  for (const child of rootNode.namedChildren) {
    switch (child.type) {
      case "using_directive":
        symbols.push(createSymbol({
          kind: "code_element",
          name: child.text.replace(/^using\s+/, "").replace(/;$/, "").trim(),
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
          signature: child.text.trim().endsWith(";")
            ? child.text.trim().slice(0, -1).trim()
            : child.text.trim(),
          exported: false,
          elementType: "using",
        }));
        break;
      case "namespace_declaration":
      case "file_scoped_namespace_declaration": {
        const nsName = getNodeText(child.childForFieldName("name")) || "(anonymous)";
        const nsSig = child.text.split("{")[0]?.trim() ?? child.text.trim();
        symbols.push(createSymbol({
          kind: "namespace",
          name: nsName,
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
          signature: nsSig.length > MAX_SIGNATURE_LENGTH
            ? nsSig.substring(0, MAX_SIGNATURE_LENGTH) + "..."
            : nsSig,
          exported: true,
          elementType: "namespace",
        }));
        const body = child.children.find((c) => c.type === "declaration_list");
        if (body) {
          symbols.push(...extractCSharpDeclarationList(body));
        } else {
          // File-scoped namespace: declarations are siblings after the namespace line
          symbols.push(...extractCSharpDeclarationList(child));
        }
        break;
      }
      case "class_declaration":
        symbols.push(...extractCSharpClassLike(child, "class"));
        break;
      case "interface_declaration":
        symbols.push(...extractCSharpClassLike(child, "interface"));
        break;
      case "struct_declaration":
        symbols.push(...extractCSharpStruct(child));
        break;
      case "enum_declaration":
        symbols.push(extractCSharpEnum(child));
        break;
      case "delegate_declaration":
        symbols.push(extractCSharpDelegate(child));
        break;
    }
  }

  return symbols;
}

// ─── C Symbol Extraction ────────────────────────────────────

function extractCFunctionName(declarator: SyntaxNode): string {
  // Dig through nested declarators to find the identifier
  const leafTypes = ["identifier", "field_identifier", "type_identifier", "destructor_name"];
  if (leafTypes.includes(declarator.type)) return declarator.text;
  const inner = declarator.childForFieldName("declarator");
  if (inner) return extractCFunctionName(inner);
  // Fallback: find first identifier-like child
  for (const child of declarator.namedChildren) {
    if (leafTypes.includes(child.type)) return child.text;
  }
  return "(anonymous)";
}

function extractCSignature(node: SyntaxNode): string {
  const body = node.children.find((c) => c.type === "compound_statement");
  let sig: string;
  if (body) {
    const source = node.text;
    const bodyOffset = body.startIndex - node.startIndex;
    sig = source.substring(0, bodyOffset).trim();
  } else {
    sig = node.text.trim();
    if (sig.endsWith(";")) sig = sig.slice(0, -1).trim();
  }
  return sig.length > MAX_SIGNATURE_LENGTH
    ? sig.substring(0, MAX_SIGNATURE_LENGTH) + "..."
    : sig;
}

function hasCStorageClass(node: SyntaxNode, keyword: string): boolean {
  return node.children.some((c) => c.type === "storage_class_specifier" && c.text === keyword);
}

function extractCParams(node: SyntaxNode): string {
  // For C, parameters are in the function_declarator's parameter_list
  const decl = node.childForFieldName("declarator");
  if (decl) {
    const params = decl.childForFieldName("parameters") ?? decl.children.find((c) => c.type === "parameter_list");
    if (params) return params.text;
  }
  return "";
}

function extractCFunction(node: SyntaxNode): ParsedSymbol {
  const decl = node.childForFieldName("declarator");
  const name = decl ? extractCFunctionName(decl) : "(anonymous)";
  const isStatic = hasCStorageClass(node, "static");
  return createSymbol({
    kind: "function",
    name,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    params: extractCParams(node),
    signature: extractCSignature(node),
    exported: !isStatic,
    isStatic,
  });
}

function extractCStruct(node: SyntaxNode): ParsedSymbol {
  const name = getNodeText(node.childForFieldName("name")) || "(anonymous)";
  const sig = node.text.trim();
  return createSymbol({
    kind: "struct",
    name,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: sig.length > MAX_SIGNATURE_LENGTH
      ? sig.substring(0, MAX_SIGNATURE_LENGTH) + "..."
      : sig,
    exported: true,
    elementType: "struct",
  });
}

function extractCEnum(node: SyntaxNode): ParsedSymbol {
  const name = getNodeText(node.childForFieldName("name")) || "(anonymous)";
  const sig = node.text.trim();
  return createSymbol({
    kind: "enum",
    name,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: sig.length > MAX_SIGNATURE_LENGTH
      ? sig.substring(0, MAX_SIGNATURE_LENGTH) + "..."
      : sig,
    exported: true,
    elementType: "enum",
  });
}

function extractCTypedef(node: SyntaxNode): ParsedSymbol {
  const decl = node.childForFieldName("declarator");
  const name = decl ? extractCFunctionName(decl) : "(anonymous)";
  const sig = node.text.trim();
  return createSymbol({
    kind: "type_alias",
    name,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: sig.endsWith(";") ? sig.slice(0, -1).trim() : sig,
    exported: true,
    elementType: "typedef",
  });
}

function extractCSymbols(rootNode: SyntaxNode): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];

  for (const child of rootNode.namedChildren) {
    switch (child.type) {
      case "function_definition":
        symbols.push(extractCFunction(child));
        break;
      case "declaration": {
        // Could be a function prototype or variable declaration
        const decl = child.childForFieldName("declarator");
        if (decl?.type === "function_declarator") {
          symbols.push(extractCFunction(child));
        }
        break;
      }
      case "struct_specifier": {
        const name = child.childForFieldName("name");
        if (name) symbols.push(extractCStruct(child));
        break;
      }
      case "enum_specifier": {
        const name = child.childForFieldName("name");
        if (name) symbols.push(extractCEnum(child));
        break;
      }
      case "type_definition":
        symbols.push(extractCTypedef(child));
        break;
    }
  }

  return symbols;
}

// ─── C++ Symbol Extraction ──────────────────────────────────

function getCppAccessFromSpecifiers(
  fieldList: SyntaxNode,
  memberIndex: number,
  defaultAccess: string,
): string {
  // Walk backwards from memberIndex to find the nearest access_specifier
  let access = defaultAccess;
  for (let i = 0; i < memberIndex; i++) {
    const child = fieldList.children[i];
    if (child.type === "access_specifier") {
      access = child.text.replace(":", "").trim();
    }
  }
  return access;
}

function hasCppVirtual(node: SyntaxNode): boolean {
  return node.children.some((c) => c.type === "virtual");
}

function hasCppPureVirtual(node: SyntaxNode): boolean {
  // Look for = 0 pattern after the declarator
  const children = node.children;
  for (let i = 0; i < children.length - 1; i++) {
    if (!children[i].isNamed && children[i].text === "=" && children[i + 1].type === "number_literal" && children[i + 1].text === "0") {
      return true;
    }
  }
  return false;
}

function extractCppSignature(node: SyntaxNode): string {
  const body = node.children.find((c) => c.type === "compound_statement" || c.type === "field_initializer_list");
  let sig: string;
  if (body) {
    const source = node.text;
    const bodyOffset = body.startIndex - node.startIndex;
    sig = source.substring(0, bodyOffset).trim();
  } else {
    sig = node.text.trim();
    if (sig.endsWith(";")) sig = sig.slice(0, -1).trim();
    // Remove pure virtual suffix = 0
    if (sig.endsWith("= 0")) sig = sig.slice(0, -3).trim();
    // Remove default suffix
    if (sig.endsWith("= default")) sig = sig.slice(0, -9).trim();
    if (sig.endsWith("= delete")) sig = sig.slice(0, -8).trim();
  }
  return sig.length > MAX_SIGNATURE_LENGTH
    ? sig.substring(0, MAX_SIGNATURE_LENGTH) + "..."
    : sig;
}

function extractCppMethodFromFieldDecl(
  node: SyntaxNode,
  className: string,
  access: string,
): ParsedSymbol | null {
  const decl = node.childForFieldName("declarator");
  if (!decl || decl.type !== "function_declarator") return null;

  const nameNode = decl.childForFieldName("declarator");
  const name = nameNode ? (nameNode.type === "field_identifier" ? nameNode.text : extractCFunctionName(nameNode)) : "(anonymous)";
  const params = decl.children.find((c) => c.type === "parameter_list");
  const isVirtual = hasCppVirtual(node);
  const isPure = hasCppPureVirtual(node);
  const isStatic = hasCStorageClass(node, "static");

  return createSymbol({
    kind: "method",
    name,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    params: params ? params.text : "",
    signature: extractCppSignature(node),
    isAbstract: isPure,
    visibility: access,
    isStatic,
    className,
    exported: access === "public",
    elementType: isVirtual ? "virtual" : "",
  });
}

function extractCppMethodFromFuncDef(
  node: SyntaxNode,
  className: string,
  access: string,
): ParsedSymbol {
  const decl = node.childForFieldName("declarator");
  const name = decl ? extractCFunctionName(decl) : "(anonymous)";
  const params = decl ? (decl.children.find((c) => c.type === "parameter_list")?.text ?? "") : "";
  const isVirtual = hasCppVirtual(node);
  const isStatic = hasCStorageClass(node, "static");

  return createSymbol({
    kind: "method",
    name,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    params,
    signature: extractCppSignature(node),
    visibility: access,
    isStatic,
    className,
    exported: access === "public",
    elementType: isVirtual ? "virtual" : "",
  });
}

function extractCppClassLike(
  node: SyntaxNode,
  elementType: string,
  defaultAccess: string,
  symbolKind: ParsedSymbol["kind"] = "class",
): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];
  const name = getNodeText(node.childForFieldName("name")) || "(anonymous)";

  const sig = extractCppSignature(node);
  symbols.push(createSymbol({
    kind: symbolKind,
    name,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: sig,
    exported: true,
    elementType,
  }));

  // Extract members from field_declaration_list
  const body = node.children.find((c) => c.type === "field_declaration_list");
  if (body) {
    for (let i = 0; i < body.children.length; i++) {
      const member = body.children[i];
      if (!member.isNamed || member.type === "access_specifier") continue;

      const access = getCppAccessFromSpecifiers(body, i, defaultAccess);

      if (member.type === "field_declaration") {
        const method = extractCppMethodFromFieldDecl(member, name, access);
        if (method) {
          symbols.push(method);
        }
        // Non-method field declarations are skipped (data members)
      } else if (member.type === "function_definition") {
        symbols.push(extractCppMethodFromFuncDef(member, name, access));
      } else if (member.type === "template_declaration") {
        // Template method inside class
        const inner = member.namedChildren.find(
          (c) => c.type === "function_definition" || c.type === "field_declaration",
        );
        if (inner) {
          if (inner.type === "function_definition") {
            symbols.push(extractCppMethodFromFuncDef(inner, name, access));
          } else {
            const method = extractCppMethodFromFieldDecl(inner, name, access);
            if (method) symbols.push(method);
          }
        }
      } else if (member.type === "class_specifier") {
        symbols.push(...extractCppClassLike(member, "", "private", "class"));
      } else if (member.type === "struct_specifier") {
        symbols.push(...extractCppClassLike(member, "struct", "public", "struct"));
      }
    }
  }

  return symbols;
}

function extractCppEnum(node: SyntaxNode): ParsedSymbol {
  const name = getNodeText(node.childForFieldName("name")) || "(anonymous)";
  const isScoped = node.children.some((c) => !c.isNamed && (c.text === "class" || c.text === "struct"));
  const sig = node.text.trim();
  return createSymbol({
    kind: "enum",
    name,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: sig.length > MAX_SIGNATURE_LENGTH
      ? sig.substring(0, MAX_SIGNATURE_LENGTH) + "..."
      : sig,
    exported: true,
    elementType: isScoped ? "enum_class" : "enum",
  });
}

function extractCppAlias(node: SyntaxNode): ParsedSymbol {
  const name = getNodeText(node.childForFieldName("name")) || "(anonymous)";
  const sig = node.text.trim();
  return createSymbol({
    kind: "type_alias",
    name,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: sig.endsWith(";") ? sig.slice(0, -1).trim() : sig,
    exported: true,
    elementType: "type_alias",
  });
}

function extractCppTopLevel(nodes: SyntaxNode[]): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];

  for (const child of nodes) {
    switch (child.type) {
      case "function_definition": {
        const decl = child.childForFieldName("declarator");
        const name = decl ? extractCFunctionName(decl) : "(anonymous)";
        const params = decl ? (decl.children.find((c) => c.type === "parameter_list")?.text ?? "") : "";
        const isStatic = hasCStorageClass(child, "static");
        symbols.push(createSymbol({
          kind: "function",
          name,
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
          params,
          signature: extractCppSignature(child),
          exported: !isStatic,
          isStatic,
        }));
        break;
      }
      case "declaration": {
        const decl = child.childForFieldName("declarator");
        if (decl?.type === "function_declarator") {
          const name = extractCFunctionName(decl);
          const params = decl.children.find((c) => c.type === "parameter_list");
          const isStatic = hasCStorageClass(child, "static");
          symbols.push(createSymbol({
            kind: "function",
            name,
            startLine: child.startPosition.row + 1,
            endLine: child.endPosition.row + 1,
            params: params ? params.text : "",
            signature: extractCppSignature(child),
            exported: !isStatic,
            isStatic,
          }));
        }
        break;
      }
      case "class_specifier": {
        const name = child.childForFieldName("name");
        if (name) symbols.push(...extractCppClassLike(child, "", "private", "class"));
        break;
      }
      case "struct_specifier": {
        const name = child.childForFieldName("name");
        if (name) symbols.push(...extractCppClassLike(child, "struct", "public", "struct"));
        break;
      }
      case "enum_specifier": {
        const name = child.childForFieldName("name");
        if (name) symbols.push(extractCppEnum(child));
        break;
      }
      case "type_definition":
        symbols.push(extractCTypedef(child));
        break;
      case "alias_declaration":
        symbols.push(extractCppAlias(child));
        break;
      case "template_declaration": {
        // Unwrap template to find the inner declaration
        const inner = child.namedChildren.filter(
          (c) => c.type !== "template_parameter_list",
        );
        symbols.push(...extractCppTopLevel(inner));
        break;
      }
      case "namespace_definition": {
        const nsName = getNodeText(child.childForFieldName("name")) || "(anonymous)";
        const nsSig = child.text.split("{")[0]?.trim() ?? child.text.trim();
        symbols.push(createSymbol({
          kind: "namespace",
          name: nsName,
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
          signature: nsSig.length > MAX_SIGNATURE_LENGTH
            ? nsSig.substring(0, MAX_SIGNATURE_LENGTH) + "..."
            : nsSig,
          exported: true,
          elementType: "namespace",
        }));
        // Recurse into namespace
        const body = child.children.find((c) => c.type === "declaration_list");
        if (body) {
          symbols.push(...extractCppTopLevel(body.namedChildren));
        }
        break;
      }
    }
  }

  return symbols;
}

function extractCppSymbols(rootNode: SyntaxNode): ParsedSymbol[] {
  return extractCppTopLevel(rootNode.namedChildren);
}

// ─── Ruby Symbol Extraction ────────────────────────────────

function extractRubySignature(node: SyntaxNode): string {
  const body = node.childForFieldName("body");
  let sig: string;
  if (body) {
    const source = node.text;
    const bodyOffset = body.startIndex - node.startIndex;
    sig = source.substring(0, bodyOffset).trim();
  } else {
    sig = node.text.trim();
  }
  return sig.length > MAX_SIGNATURE_LENGTH
    ? sig.substring(0, MAX_SIGNATURE_LENGTH) + "..."
    : sig;
}

function extractRubyParams(node: SyntaxNode): string {
  const params = node.childForFieldName("parameters");
  return params ? params.text : "";
}

function extractRubyMethod(
  node: SyntaxNode,
  className: string,
  visibility: string,
): ParsedSymbol {
  return createSymbol({
    kind: "method",
    name: getNodeText(node.childForFieldName("name")) || "(anonymous)",
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    params: extractRubyParams(node),
    signature: extractRubySignature(node),
    exported: visibility === "public",
    visibility,
    className,
  });
}

function extractRubySingletonMethod(
  node: SyntaxNode,
  className: string,
): ParsedSymbol {
  return createSymbol({
    kind: "method",
    name: getNodeText(node.childForFieldName("name")) || "(anonymous)",
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    params: extractRubyParams(node),
    signature: extractRubySignature(node),
    exported: true,
    isStatic: true,
    className,
  });
}

function extractRubyAttrAccessors(
  node: SyntaxNode,
  className: string,
): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];
  const methodNode = node.childForFieldName("method");
  if (!methodNode) return symbols;

  const attrType = methodNode.text; // attr_accessor, attr_reader, attr_writer
  const args = node.childForFieldName("arguments");
  if (!args) return symbols;

  for (const arg of args.namedChildren) {
    if (arg.type === "simple_symbol") {
      // Strip leading colon from :symbol_name
      const name = arg.text.startsWith(":") ? arg.text.slice(1) : arg.text;
      symbols.push(createSymbol({
        kind: "code_element",
        name,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        signature: `${attrType} :${name}`,
        exported: true,
        elementType: attrType,
        className,
      }));
    }
  }
  return symbols;
}

function extractRubyClassBody(
  bodyNode: SyntaxNode,
  className: string,
): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];
  let currentVisibility = "public";

  for (const member of bodyNode.namedChildren) {
    switch (member.type) {
      case "method":
        symbols.push(extractRubyMethod(member, className, currentVisibility));
        break;

      case "singleton_method":
        symbols.push(extractRubySingletonMethod(member, className));
        break;

      case "call": {
        const methodNode = member.childForFieldName("method");
        if (methodNode) {
          const methodName = methodNode.text;
          if (
            methodName === "attr_accessor" ||
            methodName === "attr_reader" ||
            methodName === "attr_writer"
          ) {
            symbols.push(...extractRubyAttrAccessors(member, className));
          }
        }
        break;
      }

      case "assignment": {
        // Class-level constants (UPPER_CASE = value)
        const left = member.childForFieldName("left");
        if (left?.type === "constant") {
          const sig = member.text.trim();
          symbols.push(createSymbol({
            kind: "code_element",
            name: left.text,
            startLine: member.startPosition.row + 1,
            endLine: member.endPosition.row + 1,
            signature: sig.length > MAX_SIGNATURE_LENGTH
              ? sig.substring(0, MAX_SIGNATURE_LENGTH) + "..."
              : sig,
            exported: true,
            elementType: "constant",
            className,
          }));
        }
        break;
      }

      case "identifier": {
        // Visibility modifiers: private, protected, public
        const text = member.text;
        if (text === "private" || text === "protected" || text === "public") {
          currentVisibility = text;
        }
        break;
      }

      case "class":
        symbols.push(...extractRubyClass(member, className));
        break;

      case "module":
        symbols.push(...extractRubyModule(member, className));
        break;
    }
  }

  return symbols;
}

function extractRubyClass(
  node: SyntaxNode,
  parentName: string,
): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];
  const rawName = getNodeText(node.childForFieldName("name")) || "(anonymous)";
  const qualifiedName = parentName ? `${parentName}::${rawName}` : rawName;

  symbols.push(createSymbol({
    kind: "class",
    name: qualifiedName,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: extractRubySignature(node),
    exported: true,
  }));

  const body = node.childForFieldName("body");
  if (body) {
    symbols.push(...extractRubyClassBody(body, qualifiedName));
  }

  return symbols;
}

function extractRubyModule(
  node: SyntaxNode,
  parentName: string,
): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];
  const rawName = getNodeText(node.childForFieldName("name")) || "(anonymous)";
  const qualifiedName = parentName ? `${parentName}::${rawName}` : rawName;

  symbols.push(createSymbol({
    kind: "code_element",
    name: qualifiedName,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: extractRubySignature(node),
    exported: true,
    elementType: "module",
  }));

  const body = node.childForFieldName("body");
  if (body) {
    symbols.push(...extractRubyClassBody(body, qualifiedName));
  }

  return symbols;
}

function extractRubySymbols(rootNode: SyntaxNode): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];

  for (const child of rootNode.namedChildren) {
    switch (child.type) {
      case "class":
        symbols.push(...extractRubyClass(child, ""));
        break;

      case "module":
        symbols.push(...extractRubyModule(child, ""));
        break;

      case "method":
        // Top-level method → function
        symbols.push(createSymbol({
          kind: "function",
          name: getNodeText(child.childForFieldName("name")) || "(anonymous)",
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
          params: extractRubyParams(child),
          signature: extractRubySignature(child),
          exported: true,
        }));
        break;

      case "singleton_method":
        // Top-level singleton method (rare but possible)
        symbols.push(createSymbol({
          kind: "function",
          name: getNodeText(child.childForFieldName("name")) || "(anonymous)",
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
          params: extractRubyParams(child),
          signature: extractRubySignature(child),
          exported: true,
          isStatic: true,
        }));
        break;

      case "assignment": {
        // Module-level constants (UPPER_CASE = value)
        const left = child.childForFieldName("left");
        if (left?.type === "constant") {
          const sig = child.text.trim();
          symbols.push(createSymbol({
            kind: "code_element",
            name: left.text,
            startLine: child.startPosition.row + 1,
            endLine: child.endPosition.row + 1,
            signature: sig.length > MAX_SIGNATURE_LENGTH
              ? sig.substring(0, MAX_SIGNATURE_LENGTH) + "..."
              : sig,
            exported: true,
            elementType: "constant",
          }));
        }
        break;
      }
    }
  }

  return symbols;
}

// ─── High-Level Parse Function ──────────────────────────────

/**
 * Parse a single file's source code and extract symbols.
 * Pure function — no DB or I/O side effects (besides tree-sitter parsing).
 */
export function parseFileContent(
  source: string,
  relativePath: string,
  language: string,
): ParsedSymbol[] {
  const grammarInfo = getGrammarForFile(relativePath, language);
  if (!grammarInfo) return [];

  const parser = new Parser();
  parser.setLanguage(grammarInfo.grammar);
  const tree = parser.parse(source, undefined, PARSE_OPTIONS);

  if (language === "python") return extractPythonSymbols(tree.rootNode);
  if (language === "rust") return extractRustSymbols(tree.rootNode);
  if (language === "go") return extractGoSymbols(tree.rootNode);
  if (language === "java") return extractJavaSymbols(tree.rootNode);
  if (language === "csharp") return extractCSharpSymbols(tree.rootNode);
  if (language === "c") return extractCSymbols(tree.rootNode);
  if (language === "cpp") return extractCppSymbols(tree.rootNode);
  if (language === "ruby") return extractRubySymbols(tree.rootNode);
  return extractSymbols(tree.rootNode, grammarInfo.supportsTypes);
}
