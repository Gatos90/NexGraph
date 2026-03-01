/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { describe, it, expect } from "vitest";
import { parseFileContent } from "./parse-core.js";
import type { ParsedSymbol } from "./parse-core.js";

// Helper to find symbol by name and optionally kind
function findSymbol(
  symbols: ParsedSymbol[],
  name: string,
  kind?: ParsedSymbol["kind"],
): ParsedSymbol | undefined {
  return symbols.find(
    (s) => s.name === name && (kind === undefined || s.kind === kind),
  );
}

// ─── TypeScript / JavaScript ────────────────────────────────

describe("parseFileContent — TypeScript", () => {
  it("extracts exported function", () => {
    const source = `export function greet(name: string): string { return "Hello " + name; }`;
    const symbols = parseFileContent(source, "file.ts", "typescript");
    const fn = findSymbol(symbols, "greet", "function");
    expect(fn).toBeDefined();
    expect(fn!.exported).toBe(true);
    expect(fn!.params).toContain("name: string");
  });

  it("extracts non-exported function", () => {
    const source = `function helper() { return 1; }`;
    const symbols = parseFileContent(source, "file.ts", "typescript");
    const fn = findSymbol(symbols, "helper", "function");
    expect(fn).toBeDefined();
    expect(fn!.exported).toBe(false);
  });

  it("extracts async function", () => {
    const source = `export async function fetchData(): Promise<void> {}`;
    const symbols = parseFileContent(source, "file.ts", "typescript");
    const fn = findSymbol(symbols, "fetchData", "function");
    expect(fn).toBeDefined();
    expect(fn!.isAsync).toBe(true);
  });

  it("extracts generator function", () => {
    const source = `export function* gen() { yield 1; }`;
    const symbols = parseFileContent(source, "file.ts", "typescript");
    const fn = findSymbol(symbols, "gen", "function");
    expect(fn).toBeDefined();
    expect(fn!.isGenerator).toBe(true);
  });

  it("extracts arrow function from const", () => {
    const source = `export const add = (a: number, b: number) => a + b;`;
    const symbols = parseFileContent(source, "file.ts", "typescript");
    const fn = findSymbol(symbols, "add", "function");
    expect(fn).toBeDefined();
    expect(fn!.exported).toBe(true);
  });

  it("extracts class with methods", () => {
    const source = `
export class UserService {
  private name: string;
  constructor(name: string) { this.name = name; }
  async fetchUser(id: number): Promise<void> {}
  static create(): UserService { return new UserService("test"); }
}`;
    const symbols = parseFileContent(source, "file.ts", "typescript");
    const cls = findSymbol(symbols, "UserService", "class");
    expect(cls).toBeDefined();
    expect(cls!.exported).toBe(true);

    const constructor = findSymbol(symbols, "constructor", "method");
    expect(constructor).toBeDefined();
    expect(constructor!.className).toBe("UserService");

    const fetchUser = findSymbol(symbols, "fetchUser", "method");
    expect(fetchUser).toBeDefined();
    expect(fetchUser!.isAsync).toBe(true);
    expect(fetchUser!.className).toBe("UserService");

    const create = findSymbol(symbols, "create", "method");
    expect(create).toBeDefined();
    expect(create!.isStatic).toBe(true);
  });

  it("extracts abstract class with abstract method", () => {
    const source = `
export abstract class Shape {
  abstract area(): number;
}`;
    const symbols = parseFileContent(source, "file.ts", "typescript");
    const cls = findSymbol(symbols, "Shape", "class");
    expect(cls).toBeDefined();
    expect(cls!.isAbstract).toBe(true);

    const area = findSymbol(symbols, "area", "method");
    expect(area).toBeDefined();
    expect(area!.isAbstract).toBe(true);
  });

  it("extracts interface", () => {
    const source = `export interface Config { port: number; host: string; }`;
    const symbols = parseFileContent(source, "file.ts", "typescript");
    const iface = findSymbol(symbols, "Config", "interface");
    expect(iface).toBeDefined();
    expect(iface!.exported).toBe(true);
  });

  it("extracts type alias", () => {
    const source = `export type ID = string | number;`;
    const symbols = parseFileContent(source, "file.ts", "typescript");
    const ta = findSymbol(symbols, "ID", "type_alias");
    expect(ta).toBeDefined();
    expect(ta!.elementType).toBe("type_alias");
  });

  it("extracts enum", () => {
    const source = `export enum Color { Red, Green, Blue }`;
    const symbols = parseFileContent(source, "file.ts", "typescript");
    const en = findSymbol(symbols, "Color", "enum");
    expect(en).toBeDefined();
    expect(en!.elementType).toBe("enum");
  });

  it("extracts const variable as code_element", () => {
    const source = `export const MAX_RETRIES = 3;`;
    const symbols = parseFileContent(source, "file.ts", "typescript");
    const c = findSymbol(symbols, "MAX_RETRIES", "code_element");
    expect(c).toBeDefined();
    expect(c!.elementType).toBe("constant");
  });

  it("extracts default export function", () => {
    const source = `export default function main() {}`;
    const symbols = parseFileContent(source, "file.ts", "typescript");
    const fn = findSymbol(symbols, "main", "function");
    expect(fn).toBeDefined();
    expect(fn!.exportDefault).toBe(true);
  });

  it("extracts class decorators", () => {
    const source = `
@Injectable()
export class Service {}`;
    const symbols = parseFileContent(source, "file.ts", "typescript");
    const cls = findSymbol(symbols, "Service", "class");
    expect(cls).toBeDefined();
    expect(cls!.decorators).toContain("Injectable");
  });

  it("extracts method decorators", () => {
    const source = `
export class Controller {
  @Get("/users")
  getUsers() {}
}`;
    const symbols = parseFileContent(source, "file.ts", "typescript");
    const method = findSymbol(symbols, "getUsers", "method");
    expect(method).toBeDefined();
    expect(method!.decorators).toContain("Get");
  });

  it("extracts method visibility", () => {
    const source = `
export class Foo {
  public bar() {}
  private baz() {}
  protected qux() {}
}`;
    const symbols = parseFileContent(source, "file.ts", "typescript");
    expect(findSymbol(symbols, "bar", "method")!.visibility).toBe("public");
    expect(findSymbol(symbols, "baz", "method")!.visibility).toBe("private");
    expect(findSymbol(symbols, "qux", "method")!.visibility).toBe("protected");
  });

  it("handles TSX file extension", () => {
    const source = `export function App() { return <div />; }`;
    const symbols = parseFileContent(source, "component.tsx", "typescript");
    const fn = findSymbol(symbols, "App", "function");
    expect(fn).toBeDefined();
  });
});

describe("parseFileContent — JavaScript", () => {
  it("extracts function declaration", () => {
    const source = `function add(a, b) { return a + b; }`;
    const symbols = parseFileContent(source, "file.js", "javascript");
    const fn = findSymbol(symbols, "add", "function");
    expect(fn).toBeDefined();
    expect(fn!.exported).toBe(false);
  });

  it("extracts exported class with methods", () => {
    const source = `
export class Counter {
  increment() { this.count++; }
}`;
    const symbols = parseFileContent(source, "file.js", "javascript");
    const cls = findSymbol(symbols, "Counter", "class");
    expect(cls).toBeDefined();
    const inc = findSymbol(symbols, "increment", "method");
    expect(inc).toBeDefined();
    expect(inc!.className).toBe("Counter");
  });

  it("does NOT extract interfaces (JS does not support types)", () => {
    // JS parser should not attempt to parse TS syntax; this is just a sanity check
    const source = `const x = 1;`;
    const symbols = parseFileContent(source, "file.js", "javascript");
    expect(symbols.filter((s) => s.kind === "interface")).toHaveLength(0);
  });
});

// ─── Python ─────────────────────────────────────────────────

describe("parseFileContent — Python", () => {
  it("extracts module-level function", () => {
    const source = `
def greet(name):
    return f"Hello {name}"
`;
    const symbols = parseFileContent(source, "file.py", "python");
    const fn = findSymbol(symbols, "greet", "function");
    expect(fn).toBeDefined();
    expect(fn!.exported).toBe(true); // Python: module-level = exported
  });

  it("extracts async function", () => {
    const source = `
async def fetch_data(url):
    pass
`;
    const symbols = parseFileContent(source, "file.py", "python");
    const fn = findSymbol(symbols, "fetch_data", "function");
    expect(fn).toBeDefined();
    expect(fn!.isAsync).toBe(true);
  });

  it("extracts class with methods", () => {
    const source = `
class UserService:
    def __init__(self, db):
        self.db = db

    def get_user(self, user_id):
        return self.db.find(user_id)

    @staticmethod
    def create():
        return UserService(None)

    @classmethod
    def from_config(cls, config):
        return cls(config.db)
`;
    const symbols = parseFileContent(source, "file.py", "python");
    const cls = findSymbol(symbols, "UserService", "class");
    expect(cls).toBeDefined();

    const init = findSymbol(symbols, "__init__", "method");
    expect(init).toBeDefined();
    expect(init!.className).toBe("UserService");

    const getUser = findSymbol(symbols, "get_user", "method");
    expect(getUser).toBeDefined();

    const create = findSymbol(symbols, "create", "method");
    expect(create).toBeDefined();
    expect(create!.isStatic).toBe(true);
  });

  it("extracts decorated function", () => {
    const source = `
@app.route("/users")
def get_users():
    pass
`;
    const symbols = parseFileContent(source, "file.py", "python");
    const fn = findSymbol(symbols, "get_users", "function");
    expect(fn).toBeDefined();
    expect(fn!.decorators).toContain("app.route");
  });

  it("extracts module-level UPPER_CASE constants", () => {
    const source = `
MAX_RETRIES = 3
DEFAULT_TIMEOUT = 30
some_variable = "not a constant"
`;
    const symbols = parseFileContent(source, "file.py", "python");
    expect(findSymbol(symbols, "MAX_RETRIES", "code_element")).toBeDefined();
    expect(findSymbol(symbols, "DEFAULT_TIMEOUT", "code_element")).toBeDefined();
    expect(findSymbol(symbols, "some_variable")).toBeUndefined();
  });

  it("extracts property decorator on method", () => {
    const source = `
class Config:
    @property
    def port(self):
        return self._port
`;
    const symbols = parseFileContent(source, "file.py", "python");
    const prop = findSymbol(symbols, "port", "method");
    expect(prop).toBeDefined();
    expect(prop!.elementType).toBe("property");
  });
});

// ─── Rust ───────────────────────────────────────────────────

describe("parseFileContent — Rust", () => {
  it("extracts pub function", () => {
    const source = `
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}
`;
    const symbols = parseFileContent(source, "lib.rs", "rust");
    const fn = findSymbol(symbols, "add", "function");
    expect(fn).toBeDefined();
    expect(fn!.exported).toBe(true);
    expect(fn!.visibility).toBe("pub");
  });

  it("extracts private function", () => {
    const source = `
fn helper() -> bool {
    true
}
`;
    const symbols = parseFileContent(source, "lib.rs", "rust");
    const fn = findSymbol(symbols, "helper", "function");
    expect(fn).toBeDefined();
    expect(fn!.exported).toBe(false);
  });

  it("extracts async function", () => {
    const source = `
pub async fn fetch_data() -> Result<(), Error> {
    Ok(())
}
`;
    const symbols = parseFileContent(source, "lib.rs", "rust");
    const fn = findSymbol(symbols, "fetch_data", "function");
    expect(fn).toBeDefined();
    expect(fn!.isAsync).toBe(true);
  });

  it("extracts struct", () => {
    const source = `
pub struct User {
    name: String,
    age: u32,
}
`;
    const symbols = parseFileContent(source, "lib.rs", "rust");
    const s = findSymbol(symbols, "User", "struct");
    expect(s).toBeDefined();
    expect(s!.elementType).toBe("struct");
    expect(s!.exported).toBe(true);
  });

  it("extracts enum", () => {
    const source = `
pub enum Color {
    Red,
    Green,
    Blue,
}
`;
    const symbols = parseFileContent(source, "lib.rs", "rust");
    const e = findSymbol(symbols, "Color", "enum");
    expect(e).toBeDefined();
    expect(e!.elementType).toBe("enum");
  });

  it("extracts trait with methods", () => {
    const source = `
pub trait Display {
    fn fmt(&self) -> String;
    fn default_method(&self) -> bool { true }
}
`;
    const symbols = parseFileContent(source, "lib.rs", "rust");
    const trait_ = findSymbol(symbols, "Display", "trait");
    expect(trait_).toBeDefined();

    const fmt = findSymbol(symbols, "fmt", "method");
    expect(fmt).toBeDefined();
    expect(fmt!.isAbstract).toBe(true);
    expect(fmt!.className).toBe("Display");

    const defaultMethod = findSymbol(symbols, "default_method", "method");
    expect(defaultMethod).toBeDefined();
    expect(defaultMethod!.isAbstract).toBe(false);
  });

  it("extracts impl block methods", () => {
    const source = `
impl User {
    pub fn new(name: String) -> Self {
        User { name, age: 0 }
    }
    fn private_helper(&self) {}
}
`;
    const symbols = parseFileContent(source, "lib.rs", "rust");
    const newFn = findSymbol(symbols, "new", "method");
    expect(newFn).toBeDefined();
    expect(newFn!.className).toBe("User");
    expect(newFn!.exported).toBe(true);

    const helper = findSymbol(symbols, "private_helper", "method");
    expect(helper).toBeDefined();
    expect(helper!.exported).toBe(false);
  });

  it("extracts trait impl methods with correct className", () => {
    const source = `
impl Display for User {
    fn fmt(&self) -> String { self.name.clone() }
}
`;
    const symbols = parseFileContent(source, "lib.rs", "rust");
    const fmt = findSymbol(symbols, "fmt", "method");
    expect(fmt).toBeDefined();
    expect(fmt!.className).toBe("Display for User");
  });

  it("extracts const and static items", () => {
    const source = `
pub const MAX_SIZE: usize = 1024;
static COUNTER: AtomicU32 = AtomicU32::new(0);
`;
    const symbols = parseFileContent(source, "lib.rs", "rust");
    const c = findSymbol(symbols, "MAX_SIZE", "code_element");
    expect(c).toBeDefined();
    expect(c!.elementType).toBe("constant");

    const s = findSymbol(symbols, "COUNTER", "code_element");
    expect(s).toBeDefined();
    expect(s!.elementType).toBe("static");
  });

  it("extracts type alias", () => {
    const source = `pub type Result<T> = std::result::Result<T, MyError>;`;
    const symbols = parseFileContent(source, "lib.rs", "rust");
    const ta = findSymbol(symbols, "Result", "type_alias");
    expect(ta).toBeDefined();
    expect(ta!.elementType).toBe("type_alias");
  });
});

// ─── Go ─────────────────────────────────────────────────────

describe("parseFileContent — Go", () => {
  it("extracts exported function (capitalized)", () => {
    const source = `
package main

func Add(a, b int) int {
    return a + b
}
`;
    const symbols = parseFileContent(source, "main.go", "go");
    const fn = findSymbol(symbols, "Add", "function");
    expect(fn).toBeDefined();
    expect(fn!.exported).toBe(true);
  });

  it("extracts unexported function (lowercase)", () => {
    const source = `
package main

func helper() bool {
    return true
}
`;
    const symbols = parseFileContent(source, "main.go", "go");
    const fn = findSymbol(symbols, "helper", "function");
    expect(fn).toBeDefined();
    expect(fn!.exported).toBe(false);
  });

  it("extracts method with receiver", () => {
    const source = `
package main

type User struct { Name string }

func (u *User) GetName() string {
    return u.Name
}
`;
    const symbols = parseFileContent(source, "main.go", "go");
    const m = findSymbol(symbols, "GetName", "method");
    expect(m).toBeDefined();
    expect(m!.className).toBe("User"); // pointer stripped
    expect(m!.exported).toBe(true);
  });

  it("extracts struct type declaration", () => {
    const source = `
package main

type Config struct {
    Port int
    Host string
}
`;
    const symbols = parseFileContent(source, "main.go", "go");
    const s = findSymbol(symbols, "Config", "struct");
    expect(s).toBeDefined();
    expect(s!.elementType).toBe("struct");
    expect(s!.exported).toBe(true);
  });

  it("extracts interface with method signatures", () => {
    const source = `
package main

type Reader interface {
    Read(p []byte) (n int, err error)
}
`;
    const symbols = parseFileContent(source, "main.go", "go");
    const iface = findSymbol(symbols, "Reader", "interface");
    expect(iface).toBeDefined();

    const readMethod = findSymbol(symbols, "Read", "method");
    expect(readMethod).toBeDefined();
    expect(readMethod!.isAbstract).toBe(true);
    expect(readMethod!.className).toBe("Reader");
  });

  it("extracts constants", () => {
    const source = `
package main

const MaxRetries = 3
const defaultTimeout = 30
`;
    const symbols = parseFileContent(source, "main.go", "go");
    const max = findSymbol(symbols, "MaxRetries", "code_element");
    expect(max).toBeDefined();
    expect(max!.exported).toBe(true);

    const def = findSymbol(symbols, "defaultTimeout", "code_element");
    expect(def).toBeDefined();
    expect(def!.exported).toBe(false);
  });
});

// ─── Java ───────────────────────────────────────────────────

describe("parseFileContent — Java", () => {
  it("extracts public class with methods", () => {
    const source = `
public class UserService {
    private String name;

    public UserService(String name) {
        this.name = name;
    }

    public String getName() {
        return name;
    }

    private void helper() {}

    public static UserService create() {
        return new UserService("test");
    }
}
`;
    const symbols = parseFileContent(source, "UserService.java", "java");
    const cls = findSymbol(symbols, "UserService", "class");
    expect(cls).toBeDefined();
    expect(cls!.exported).toBe(true);
    expect(cls!.visibility).toBe("public");

    const constructor = findSymbol(symbols, "UserService", "method");
    expect(constructor).toBeDefined();
    expect(constructor!.elementType).toBe("constructor");

    const getName = findSymbol(symbols, "getName", "method");
    expect(getName).toBeDefined();
    expect(getName!.visibility).toBe("public");

    const helper = findSymbol(symbols, "helper", "method");
    expect(helper).toBeDefined();
    expect(helper!.visibility).toBe("private");

    const create = findSymbol(symbols, "create", "method");
    expect(create).toBeDefined();
    expect(create!.isStatic).toBe(true);
  });

  it("extracts abstract class", () => {
    const source = `
public abstract class Shape {
    public abstract double area();
}
`;
    const symbols = parseFileContent(source, "Shape.java", "java");
    const cls = findSymbol(symbols, "Shape", "class");
    expect(cls).toBeDefined();
    expect(cls!.isAbstract).toBe(true);

    const area = findSymbol(symbols, "area", "method");
    expect(area).toBeDefined();
    expect(area!.isAbstract).toBe(true);
  });

  it("extracts interface with methods", () => {
    const source = `
public interface Repository {
    void save(Object entity);
    Object findById(int id);
}
`;
    const symbols = parseFileContent(source, "Repository.java", "java");
    const iface = findSymbol(symbols, "Repository", "interface");
    expect(iface).toBeDefined();

    const save = findSymbol(symbols, "save", "method");
    expect(save).toBeDefined();
    expect(save!.isAbstract).toBe(true);
  });

  it("extracts enum", () => {
    const source = `
public enum Color {
    RED, GREEN, BLUE;

    public String display() { return name().toLowerCase(); }
}
`;
    const symbols = parseFileContent(source, "Color.java", "java");
    const en = findSymbol(symbols, "Color", "enum");
    expect(en).toBeDefined();
    expect(en!.elementType).toBe("enum");

    const display = findSymbol(symbols, "display", "method");
    expect(display).toBeDefined();
  });

  it("extracts annotations on class", () => {
    const source = `
@Entity
@Table
public class User {}
`;
    const symbols = parseFileContent(source, "User.java", "java");
    const cls = findSymbol(symbols, "User", "class");
    expect(cls).toBeDefined();
    expect(cls!.decorators).toContain("Entity");
    expect(cls!.decorators).toContain("Table");
  });

  it("extracts record", () => {
    const source = `
public record Point(int x, int y) {
    public double distance() { return Math.sqrt(x*x + y*y); }
}
`;
    const symbols = parseFileContent(source, "Point.java", "java");
    const rec = findSymbol(symbols, "Point", "class");
    expect(rec).toBeDefined();
    expect(rec!.elementType).toBe("record");

    const dist = findSymbol(symbols, "distance", "method");
    expect(dist).toBeDefined();
  });

  it("extracts static final field as constant", () => {
    const source = `
public class Constants {
    public static final int MAX_SIZE = 100;
}
`;
    const symbols = parseFileContent(source, "Constants.java", "java");
    const field = findSymbol(symbols, "MAX_SIZE", "code_element");
    expect(field).toBeDefined();
    expect(field!.elementType).toBe("constant");
    expect(field!.isStatic).toBe(true);
  });
});

// ─── Edge Cases ─────────────────────────────────────────────

describe("parseFileContent — Edge Cases", () => {
  it("returns empty array for unsupported language", () => {
    const symbols = parseFileContent("int main() {}", "file.rb", "ruby");
    expect(symbols).toEqual([]);
  });

  it("handles empty source gracefully", () => {
    const symbols = parseFileContent("", "file.ts", "typescript");
    expect(symbols).toEqual([]);
  });

  it("handles syntax errors gracefully", () => {
    const source = `export function incomplete(`;
    const symbols = parseFileContent(source, "file.ts", "typescript");
    // Should not throw, may return partial results
    expect(Array.isArray(symbols)).toBe(true);
  });
});
