---
name: nexgraph-exploring
description: "Use when the user asks how code works, wants to understand architecture, trace execution flows, or explore unfamiliar parts of the codebase. Examples: \"How does X work?\", \"What calls this function?\", \"Show me the auth flow\""
---

# Exploring Codebases with NexGraph

## When to Use

- "How does authentication work?"
- "What's the project structure?"
- "Show me the main components"
- "Where is the database logic?"
- Understanding code you haven't seen before

## Workflow

```
1. READ nexgraph://repos                             -> Discover indexed repos
2. READ nexgraph://repos/{repo}/stats                -> Scale overview (nodes, edges, files)
3. query({keyword: "<what you want to understand>"})   -> Find related symbols
4. context({symbol: "<key symbol>"})                 -> Deep dive: callers, callees, imports
5. trace({start_symbol: "<entry>"})                  -> Map execution flow end-to-end
6. read_file({path: "<file>"})                       -> Read actual implementation
7. Optional: communities() for functional clusters, processes() for execution flow list
```

## Checklist

```
- [ ] READ nexgraph://repos -- confirm repo is indexed
- [ ] READ nexgraph://repos/{repo}/stats -- understand scale
- [ ] query for the concept you want to understand
- [ ] context on key symbols for callers/callees
- [ ] trace from entry point to map execution flow
- [ ] Read source files for implementation details
- [ ] Summarize findings with file paths and flow diagram
```

## Resources

| Resource                        | What you get                                       |
| ------------------------------- | -------------------------------------------------- |
| `nexgraph://repos`              | All repos with indexing status and file counts     |
| `nexgraph://repos/{repo}/stats` | Graph statistics -- node/edge counts by label      |
| `nexgraph://repos/{repo}/tree`  | Full file tree for navigation                      |
| `nexgraph://connections`        | Cross-repo links (for multi-repo projects)         |

## Tools

**query** -- find symbols related to a concept:

```
query({keyword: "payment processing"})
-> Matches: processPayment (Function, src/payments/processor.ts)
            PaymentService (Class, src/payments/service.ts)
            chargeStripe (Function, src/payments/stripe.ts)
```

**context** -- 360-degree view of a symbol:

```
context({symbol: "processPayment"})
-> Callers: checkoutHandler, webhookHandler
-> Callees: validateCard, chargeStripe, saveTransaction
-> Imports: stripe-sdk, database
-> Exported: yes
-> File: src/payments/processor.ts:42
```

## Example: "How does payment processing work?"

```
1. READ nexgraph://repos/{repo}/stats
   -> 2847 nodes, 9123 edges, 385 files

2. query({keyword: "payment processing"})
   -> processPayment, PaymentService, chargeStripe, RefundHandler

3. context({symbol: "processPayment"})
   -> Callers: checkoutHandler, webhookHandler
   -> Callees: validateCard, chargeStripe, saveTransaction

4. trace({start_symbol: "processPayment"})
   -> processPayment -> validateCard -> chargeStripe -> saveTransaction

5. read_file({path: "src/payments/processor.ts"})
   -> Implementation details with line numbers
```
