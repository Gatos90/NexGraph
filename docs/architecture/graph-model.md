# Graph Model

NexGraph stores code relationships in an Apache AGE property graph. Each repository gets its own named graph.

## Node Labels

### Folder
Represents a directory in the source tree.

| Property | Type | Description |
|----------|------|-------------|
| `path` | string | Relative path from repo root |
| `name` | string | Directory name |

### File
Represents a source file.

| Property | Type | Description |
|----------|------|-------------|
| `path` | string | Relative path from repo root |
| `language` | string | Detected programming language |
| `size` | number | File size in bytes |

### Function
A standalone function or arrow function.

| Property | Type | Description |
|----------|------|-------------|
| `name` | string | Function name |
| `file_path` | string | File containing this function |
| `line` | number | Start line number |
| `exported` | boolean | Whether the function is exported |
| `async` | boolean | Whether the function is async |
| `parameters` | string | Parameter signature |

### Class
A class declaration.

| Property | Type | Description |
|----------|------|-------------|
| `name` | string | Class name |
| `file_path` | string | File containing this class |
| `line` | number | Start line number |
| `exported` | boolean | Whether the class is exported |
| `decorators` | string | Comma-separated decorator names |

### Interface
An interface declaration.

| Property | Type | Description |
|----------|------|-------------|
| `name` | string | Interface name |
| `file_path` | string | File containing this interface |
| `line` | number | Start line number |
| `exported` | boolean | Whether the interface is exported |

### Method
A method within a class.

| Property | Type | Description |
|----------|------|-------------|
| `name` | string | Method name |
| `class_name` | string | Parent class name |
| `file_path` | string | File containing this method |
| `line` | number | Start line number |
| `visibility` | string | public, private, or protected |
| `static` | boolean | Whether the method is static |
| `async` | boolean | Whether the method is async |

### CodeElement
A catch-all for other symbols (constants, etc.).

| Property | Type | Description |
|----------|------|-------------|
| `name` | string | Element name |
| `kind` | string | Specific kind (const, variable, etc.) |
| `file_path` | string | File containing this element |
| `line` | number | Start line number |
| `exported` | boolean | Whether the element is exported |

### RouteHandler
An HTTP route handler detected via AST analysis (Express, NestJS, Flask, FastAPI, Spring, Go net/http, etc.).

| Property | Type | Description |
|----------|------|-------------|
| `name` | string | Handler function name |
| `http_method` | string | HTTP method (GET, POST, PUT, DELETE, etc.) |
| `url_pattern` | string | URL path pattern |
| `framework` | string | Detected framework (express, nestjs, flask, etc.) |
| `file_path` | string | File containing this handler |
| `start_line` | number | Start line number |

### Struct
A struct declaration (Go, Rust, C#).

| Property | Type | Description |
|----------|------|-------------|
| `name` | string | Struct name |
| `file_path` | string | File containing this struct |
| `line` | number | Start line number |
| `exported` | boolean | Whether the struct is exported |

### Enum
An enum declaration.

| Property | Type | Description |
|----------|------|-------------|
| `name` | string | Enum name |
| `file_path` | string | File containing this enum |
| `line` | number | Start line number |
| `exported` | boolean | Whether the enum is exported |

### Trait
A trait or protocol declaration (Rust, Swift).

| Property | Type | Description |
|----------|------|-------------|
| `name` | string | Trait name |
| `file_path` | string | File containing this trait |
| `line` | number | Start line number |
| `exported` | boolean | Whether the trait is exported |

### TypeAlias
A type alias declaration (`type X = ...`).

| Property | Type | Description |
|----------|------|-------------|
| `name` | string | Type alias name |
| `file_path` | string | File containing this type alias |
| `line` | number | Start line number |
| `exported` | boolean | Whether the type alias is exported |

### Namespace
A namespace or module block declaration.

| Property | Type | Description |
|----------|------|-------------|
| `name` | string | Namespace name |
| `file_path` | string | File containing this namespace |
| `line` | number | Start line number |
| `exported` | boolean | Whether the namespace is exported |

### Community
A functional cluster detected via Leiden community detection on the CALLS graph.

| Property | Type | Description |
|----------|------|-------------|
| `community_id` | string | Unique community identifier |
| `label` | string | Heuristic label (folder name, common prefix, or fallback) |
| `symbol_count` | number | Number of member symbols |
| `cohesion` | number | Internal edge ratio (0.0–1.0) |
| `keywords` | string | Comma-separated keywords from member names |

### Process
A detected execution flow traced from an entry point through CALLS edges.

| Property | Type | Description |
|----------|------|-------------|
| `process_id` | string | Unique process identifier |
| `entry_name` | string | Entry point symbol name |
| `terminal_name` | string | Terminal symbol name |
| `step_count` | number | Number of steps in the flow |
| `type` | string | `intra_community` or `cross_community` |

## Edge Labels

| Edge | From | To | Description |
|------|------|----|-------------|
| `CONTAINS` | Folder/File | File/Symbol | Parent contains child |
| `DEFINES` | File | Symbol | File defines a symbol |
| `EXPOSES` | File | Symbol | File exports a symbol |
| `IMPORTS` | File | File | File imports from another file |
| `CALLS` | Symbol | Symbol | Symbol calls another symbol |
| `EXTENDS` | Class | Class | Class inheritance |
| `IMPLEMENTS` | Class | Interface | Interface implementation |
| `OVERRIDES` | Method | Method | Child method overrides parent method |
| `HANDLES` | Function | RouteHandler | Function handles an HTTP route |
| `MEMBER_OF` | Symbol | Community | Symbol belongs to a community cluster |
| `STEP_IN_PROCESS` | Symbol | Process | Symbol is a step in an execution flow |

### CALLS Edge Properties

| Property | Type | Description |
|----------|------|-------------|
| `confidence` | number | Resolution confidence (0.0–1.0) |
| `tier` | number | Resolution tier (1, 2, or 3) |

### STEP_IN_PROCESS Edge Properties

| Property | Type | Description |
|----------|------|-------------|
| `step` | number | Order of this step in the process (0-based) |
