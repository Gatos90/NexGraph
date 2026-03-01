---
name: nexgraph-impact-analysis
description: "Use when the user wants to know what will break if they change something, or needs safety analysis before editing code. Examples: \"Is it safe to change X?\", \"What depends on this?\", \"What will break?\", \"Show me the blast radius\""
---

# Impact Analysis with NexGraph

## When to Use

- "Is it safe to change this function?"
- "What will break if I modify X?"
- "Show me the blast radius"
- "Who uses this code?"
- Before making non-trivial code changes
- Before committing -- to understand what your changes affect

## Workflow

```
1. impact({symbol: "X", direction: "callers", depth: 3})  -> What depends on this
2. processes() or communities()                             -> Check affected execution flows
3. detect_changes({scope: "staged"})                       -> Map current git changes to impact
4. cross_repo_connections()                                 -> Check multi-repo impact if applicable
5. Assess risk and report to user
```

## Checklist

```
- [ ] impact({symbol: ..., direction: "callers"}) to find dependents
- [ ] Review depth=1 items first (these WILL BREAK)
- [ ] Check affected execution flows via processes()
- [ ] detect_changes() for pre-commit impact check
- [ ] Check cross-repo impact if multi-repo project
- [ ] Assess risk level and report to user
```

## Understanding Output

| Depth | Risk Level       | Meaning                  |
| ----- | ---------------- | ------------------------ |
| d=1   | **WILL BREAK**   | Direct callers/importers |
| d=2   | LIKELY AFFECTED  | Indirect dependencies    |
| d=3   | MAY NEED TESTING | Transitive effects       |

## Risk Assessment

| Affected Scope                   | Risk     |
| -------------------------------- | -------- |
| <5 symbols, single area         | LOW      |
| 5-15 symbols, 2-5 areas         | MEDIUM   |
| >15 symbols or many areas       | HIGH     |
| Critical path (auth, payments)  | CRITICAL |

## Tools

**impact** -- the primary tool for symbol blast radius:

```
impact({symbol: "validateUser", direction: "callers", depth: 3})

-> depth 1 (WILL BREAK):
   - loginHandler (src/auth/login.ts:42) [CALLS]
   - apiMiddleware (src/api/middleware.ts:15) [CALLS]

-> depth 2 (LIKELY AFFECTED):
   - authRouter (src/routes/auth.ts:22) [CALLS]
   - sessionManager (src/auth/session.ts:8) [CALLS]

-> depth 3 (MAY NEED TESTING):
   - appSetup (src/app.ts:5) [CALLS]
```

**detect_changes** -- git-diff based impact analysis:

```
detect_changes({scope: "staged"})

-> Changed symbols: 5 in 3 files
-> Affected callers: 12
-> Risk: MEDIUM
```

**cross_repo_connections** -- check multi-repo dependencies:

```
cross_repo_connections()

-> frontend -> backend: 15 edges (API calls)
-> backend -> shared-types: 8 edges (type imports)
```

## Example: "What breaks if I change validateUser?"

```
1. impact({symbol: "validateUser", direction: "callers", depth: 3})
   -> d=1: loginHandler, apiMiddleware (WILL BREAK)
   -> d=2: authRouter, sessionManager (LIKELY AFFECTED)
   -> d=3: appSetup (MAY NEED TESTING)

2. processes()
   -> LoginFlow and TokenRefresh touch validateUser

3. cross_repo_connections()
   -> No cross-repo callers -- safe from multi-repo impact

4. Risk: 2 direct callers, 2 execution flows = MEDIUM
   -> Test LoginFlow and TokenRefresh after changes
```
