---
title: usage and cost
description: What cube's token counts and estimated costs mean, where they come from, and where to read them.
---

cube reports the tokens its agents used and an estimated cost, per thread, project and model, and for the chat itself. Every figure comes from a record an agent already keeps. cube adds no meter of its own and never calls a provider's billing API.

## where to read it

| where | shows |
|---|---|
| a thread's top rail | the thread's estimate, with details in its tooltip |
| a project page | the project's usage, by model and thread |
| **settings** › **system** | everything, by project, model and thread, and the chat's own |
| the chat | ask it: everything, a project or a thread |
| `GET /api/usage`, `?project=<id>` | the same, as JSON |
| `GET /api/threads/<id>/usage` | one thread, archived ones too |

## what the numbers mean

- **Tokens** are what the provider reported to the agent: input, output, cache read, cache write and, where the record splits it out, reasoning, which is part of output.
- **Estimated cost** is never a charge. Pi prices each response at its model catalog's rates when the response is recorded. Claude Code prices its own calls at its built-in list prices.
- **Billed cost** is always empty. No provider reports charges to cube.
- **Subscriptions.** A Claude Code thread on a Claude subscription shows what the calls would cost at list prices, not what you paid. A Pi provider reached through a subscription login is estimated at catalog prices too.
- **Unpriced tokens** are tokens with no price behind them, such as a local model's or a custom model's. They are never counted as $0. A spend reads `≈ $X est.`, `≈ $X est. + N unpriced tokens` or `cost unknown (N unpriced tokens)`.
- **Unknown usage is not zero.** A thread's coverage is `complete`, `partial` or `unavailable`. Totals count unavailable threads and unknown turns apart and never fold them in as zero.

## what is not covered

- Billed amounts from any provider, and reconciliation with invoices.
- A response cut off when cubed crashed mid-stream. The agent records a response when it ends, but the provider may still bill it.
- A model whose catalog price is $0, such as a local model, cannot be told from a model with no price. Its tokens count as unpriced.
