declare module "tree-sitter-typescript" {
  import Parser from "tree-sitter";

  const grammar: {
    typescript: Parser.Language;
    tsx: Parser.Language;
  };

  export default grammar;
}

declare module "tree-sitter-javascript" {
  import Parser from "tree-sitter";
  const grammar: Parser.Language;
  export default grammar;
}

declare module "tree-sitter-python" {
  import Parser from "tree-sitter";
  const grammar: Parser.Language;
  export default grammar;
}

declare module "tree-sitter-rust" {
  import Parser from "tree-sitter";
  const grammar: Parser.Language;
  export default grammar;
}

declare module "tree-sitter-go" {
  import Parser from "tree-sitter";
  const grammar: Parser.Language;
  export default grammar;
}

declare module "tree-sitter-java" {
  import Parser from "tree-sitter";
  const grammar: Parser.Language;
  export default grammar;
}

declare module "tree-sitter-c-sharp" {
  import Parser from "tree-sitter";
  const grammar: Parser.Language;
  export default grammar;
}

declare module "tree-sitter-c" {
  import Parser from "tree-sitter";
  const grammar: Parser.Language;
  export default grammar;
}

declare module "tree-sitter-cpp" {
  import Parser from "tree-sitter";
  const grammar: Parser.Language;
  export default grammar;
}

declare module "tree-sitter-ruby" {
  import Parser from "tree-sitter";
  const grammar: Parser.Language;
  export default grammar;
}
