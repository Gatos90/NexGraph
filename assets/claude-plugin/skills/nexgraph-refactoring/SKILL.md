---
name: nexgraph-refactoring
description: "Use when the user wants to rename, extract, split, move, or restructure code safely. Examples: \"Rename this function\", \"Extract this into a module\", \"Refactor this class\", \"Move this to a separate file\""
---

# Refactoring with NexGraph

## When to Use

- "Rename this function safely"
- "Extract this into a module"
- "Split this service"
- "Move this to a new file"
- Any task involving renaming, extracting, splitting, or restructuring code

## Workflow

```
1. impact({symbol: "X", direction: "callers"})   -> Map all dependents
2. query({query: "X"})                            -> Find the symbol and related code
3. context({symbol: "X"})                         -> See all incoming/outgoing refs
4. communities()                                  -> Check if X spans functional clusters
5. Plan update order: interfaces -> implementations -> callers -> tests
```

## Checklists

### Rename Symbol

```
- [ ] rename({symbol: "oldName", new_name: "newName", dry_run: true}) -- preview all edits
- [ ] Review edits: check confidence scores, flag any below 0.8
- [ ] If satisfied: rename({symbol: "oldName", new_name: "newName", dry_run: false}) -- apply
- [ ] detect_changes({scope: "all"}) -- verify only expected files changed
- [ ] Run tests for affected processes
```

### Extract Module

```
- [ ] context({symbol: "target"}) -- see all incoming/outgoing refs
- [ ] impact({symbol: "target", direction: "callers"}) -- find all external callers
- [ ] dependencies({file_path: "target/file.ts"}) -- understand import tree
- [ ] Define new module interface
- [ ] Extract code, update imports
- [ ] detect_changes({scope: "all"}) -- verify affected scope
- [ ] architecture_check() -- verify no layer violations introduced
- [ ] Run tests for affected processes
```

### Split Function/Service

```
- [ ] context({symbol: "target"}) -- understand all callees
- [ ] communities() -- see functional clusters to guide split boundaries
- [ ] Group callees by responsibility
- [ ] impact({symbol: "target", direction: "callers"}) -- map callers to update
- [ ] Create new functions/services
- [ ] Update callers
- [ ] detect_changes({scope: "all"}) -- verify affected scope
- [ ] Run tests for affected processes
```

## Tools

**rename** -- automated multi-file rename with confidence scoring:

```
rename({symbol: "validateUser", new_name: "authenticateUser", dry_run: true})
-> 12 edits across 8 files
-> Changes: [{file_path, edits: [{line, old_text, new_text, confidence}]}]
```

**impact** -- map all dependents first:

```
impact({symbol: "validateUser", direction: "callers", depth: 3})
-> d=1: loginHandler, apiMiddleware, testUtils
-> d=2: authRouter, sessionManager
-> Affected symbols: 5
```

**detect_changes** -- verify your changes after refactoring:

```
detect_changes({scope: "all"})
-> Changed: 8 files, 12 symbols
-> Risk: MEDIUM
```

**cypher** -- custom reference queries:

```cypher
MATCH (caller)-[e:CodeRelation]->(f:Function {name: "validateUser"})
WHERE e.type = 'CALLS'
RETURN caller.name, caller.file_path ORDER BY caller.file_path
```

## Risk Rules

| Risk Factor         | Mitigation                                           |
| ------------------- | ---------------------------------------------------- |
| Many callers (>5)   | Use `rename` for automated updates                   |
| Cross-area refs     | Use `detect_changes` after to verify scope           |
| String/dynamic refs | `search` or `grep` to find them                      |
| External/public API | Version and deprecate properly                       |
| Import tree complex | `dependencies` to map the full import tree           |
| Layer violations    | `architecture_check` to verify no rules broken       |

## Example: Rename `validateUser` to `authenticateUser`

```
1. rename({symbol: "validateUser", new_name: "authenticateUser", dry_run: true})
   -> 12 edits: confidence 0.85-1.0
   -> Files: validator.ts, login.ts, middleware.ts, auth.test.ts...

2. Review low-confidence edits (config.json: dynamic reference!)

3. rename({symbol: "validateUser", new_name: "authenticateUser", dry_run: false})
   -> Applied 12 edits across 8 files

4. detect_changes({scope: "all"})
   -> Changed: 8 files, 12 symbols
   -> Risk: MEDIUM -- run tests for auth flows
```
