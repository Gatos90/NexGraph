---
name: nexgraph-debugging
description: "Use when the user is debugging a bug, tracing an error, or asking why something fails. Examples: \"Why is X failing?\", \"Where does this error come from?\", \"Trace this bug\", \"This endpoint returns 500\""
---

# Debugging with NexGraph

## When to Use

- "Why is this function failing?"
- "Trace where this error comes from"
- "Who calls this method?"
- "This endpoint returns 500"
- Investigating bugs, errors, or unexpected behavior

## Workflow

```
1. search({query: "<error or symptom>", mode: "hybrid"})  -> Find related code by content
2. query({query: "<suspect symbol>"})                      -> Locate symbols in the graph
3. context({symbol: "<suspect>"})                          -> See callers/callees
4. trace({start_symbol: "<failing>", direction: "backward"}) -> Trace upstream callers
5. read_file({path: "<file>", start_line: N, end_line: M}) -> Confirm root cause in source
6. Optional: cypher for custom call chain queries, grep for text-level search
```

## Checklist

```
- [ ] Understand the symptom (error message, unexpected behavior)
- [ ] search (hybrid) for error text or related code
- [ ] query to find candidate symbols in the graph
- [ ] context on suspect function to see callers and callees
- [ ] trace backward from failing symbol to find entry path
- [ ] read_file to confirm root cause in source code
- [ ] If fixing: impact to verify fix won't break other callers
```

## Debugging Patterns

| Symptom              | NexGraph Approach                                          |
| -------------------- | ---------------------------------------------------------- |
| Error message        | `search` (hybrid) for error text -> `context` on throw sites |
| Wrong return value   | `context` on the function -> trace callees for data flow   |
| Intermittent failure | `context` -> look for external calls, async deps          |
| Performance issue    | `context` -> find symbols with many callers (hot paths)   |
| Recent regression    | `detect_changes` to see what your changes affect          |

## Tools

**search** -- find code related to an error:

```
search({query: "payment validation error", mode: "hybrid"})
-> src/payments/validator.ts:42 :: validatePayment
   "throws PaymentValidationError when card is expired"
-> src/payments/handler.ts:88 :: handlePaymentError
   "catches PaymentValidationError and returns 400"
```

**context** -- full context for a suspect:

```
context({symbol: "validatePayment"})
-> Callers: processCheckout, webhookHandler
-> Callees: verifyCard, fetchRates (external API!)
-> File: src/payments/validator.ts:42
-> Exported: yes
```

**cypher** -- custom call chain traces:

```cypher
MATCH path = (a)-[:CodeRelation {type: 'CALLS'}*1..3]->(b:Function {name: "validatePayment"})
RETURN [n IN nodes(path) | n.name] AS chain
```

## Example: "Payment endpoint returns 500 intermittently"

```
1. search({query: "payment error handling", mode: "hybrid"})
   -> validatePayment (src/payments/validator.ts)
   -> handlePaymentError (src/payments/handler.ts)

2. context({symbol: "validatePayment"})
   -> Callees: verifyCard, fetchRates (external API!)

3. trace({start_symbol: "validatePayment", direction: "forward"})
   -> validatePayment -> verifyCard -> OK
   -> validatePayment -> fetchRates -> EXTERNAL (no timeout!)

4. read_file({path: "src/payments/validator.ts", start_line: 42, end_line: 60})
   -> Root cause: fetchRates calls external API without timeout handling
```
