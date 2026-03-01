---
name: nexgraph-guide
description: "Use when the user asks about NexGraph itself -- available tools, how to query the knowledge graph, MCP resources, graph schema, or workflow reference. Examples: \"What NexGraph tools are available?\", \"How do I use NexGraph?\", \"What can I query?\""
---

# NexGraph Guide

Quick reference for all NexGraph MCP tools, resources, and the knowledge graph schema.

## Always Start Here

For any task involving code understanding, debugging, impact analysis, or refactoring:

1. **Read `nexgraph://repos`** -- discover indexed repos and check freshness
2. **Match your task to a skill below** and follow its workflow
3. **Use the checklist** in that skill to ensure thorough analysis

## Skills

| Task                                         | Skill                    |
| -------------------------------------------- | ------------------------ |
| Understand architecture / "How does X work?" | `nexgraph-exploring`     |
| Blast radius / "What breaks if I change X?"  | `nexgraph-impact-analysis` |
| Trace bugs / "Why is X failing?"             | `nexgraph-debugging`     |
| Rename / extract / split / refactor          | `nexgraph-refactoring`   |
| Setup, installation, server management       | `nexgraph-cli`           |
| Tools, resources, schema reference           | `nexgraph-guide` (this)  |

## Tools Reference

| Tool                     | What it gives you                                                     |
| ------------------------ | --------------------------------------------------------------------- |
| `query`                  | Find symbols by name -- substring match across the graph              |
| `context`                | 360-degree symbol view -- callers, callees, imports, exports          |
| `impact`                 | Blast radius -- what depends on a symbol at depth 1/2/3               |
| `trace`                  | End-to-end call chain tracing from a starting symbol                  |
| `search`                 | Full-text keyword, semantic, or hybrid search across file contents    |
| `grep`                   | Regex search with line context across repository files                |
| `read_file`              | Open a source file with line numbers and symbol annotations           |
| `file_tree`              | Browse repository directory structure                                 |
| `dependencies`           | File-level import/dependency tree for a given file                    |
| `cypher`                 | Raw Cypher queries against the graph                                  |
| `graph_stats`            | Node/edge counts by label, indexing status                            |
| `routes`                 | List detected HTTP route handlers                                     |
| `nodes`                  | List/filter graph nodes with pagination                               |
| `edges`                  | List graph edges by type                                              |
| `orphans`                | Find unreferenced symbols (dead code detection)                       |
| `communities`            | Functional clusters detected via graph analysis                       |
| `processes`              | Detected execution flow traces through the codebase                   |
| `path`                   | Shortest path between two symbols in the graph                        |
| `rename`                 | Multi-file coordinated rename with confidence-scored edits            |
| `detect_changes`         | Git-diff impact -- map changed symbols to affected code               |
| `architecture_check`     | Detect layer violations using custom rules                            |
| `cross_repo_connections` | Cross-repo link rules and resolved edge counts                        |
| `git_history`            | Per-file git stats -- authors, commit counts, last modified           |
| `git_timeline`           | Chronological commit timeline with co-change patterns                 |

## Resources Reference

| Resource                         | Content                                            |
| -------------------------------- | -------------------------------------------------- |
| `nexgraph://project/info`        | Project metadata, settings, and repository list    |
| `nexgraph://repos`               | All repos with indexing status and file counts     |
| `nexgraph://repos/{repo}/tree`   | File tree of a repository                          |
| `nexgraph://repos/{repo}/stats`  | Graph statistics (node/edge counts by label)       |
| `nexgraph://connections`         | Cross-repo connection rules with edge counts       |

## Graph Schema

**Node labels:** File, Function, Class, Interface, Method, RouteHandler, Community, Process

**Edge types (CodeRelation.type):** CALLS, IMPORTS, EXTENDS, IMPLEMENTS, DEFINES, MEMBER_OF, STEP_IN_PROCESS

```cypher
-- Example: find all callers of a function
MATCH (caller)-[e:CodeRelation]->(f:Function {name: "myFunc"})
WHERE e.type = 'CALLS'
RETURN caller.name, caller.file_path
```

## Recommended Baseline Workflow

```
1. READ nexgraph://repos                          -> discover repos
2. graph_stats()                                   -> confirm graph health
3. query({query: "concept"})                       -> find symbol candidates
4. context({symbol: "topCandidate"})               -> 360-degree view
5. read_file({path: "src/relevant/file.ts"})       -> implementation detail
6. impact({symbol: "target"})                      -> before proposing edits
```
