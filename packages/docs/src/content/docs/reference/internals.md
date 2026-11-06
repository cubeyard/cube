---
title: maintainer docs
description: Where cube's design, architecture and operations details live in the repository, for contributors and operators who need more than this site.
---

This site covers using and running cube. The repository keeps the detailed references maintainers work from, next to the code. Each link below opens the file at the release this site documents.

## design and architecture

- [ARCHITECTURE.md](gh:ARCHITECTURE.md): how the pieces fit, ownership, the runner protocol and its invariants.
- [PRODUCT.md](gh:PRODUCT.md): who cube is for and what it promises.
- [DESIGN.md](gh:DESIGN.md): the visual system this site shares with the app.

## subsystem references

- [OptChat](gh:docs/optchat.md): the chat's tools, memory, caching and limits.
- [Thread lifecycle](gh:docs/thread-lifecycle.md): every state machine, event and owner.
- [Runner operations](gh:docs/runner-operations.md): enrollment, observation, diagnostics and protocol-3 retirement.
- [Artifacts](gh:docs/artifacts.md), [skills](gh:docs/skills.md), [services and the portal](gh:docs/services.md), [project hooks](gh:docs/project-hooks.md).
- [Usage](gh:docs/usage.md) and [telemetry export](gh:docs/telemetry.md).
- [cubed updates](gh:docs/cubed-updates.md): signed releases, the managed launcher and rollback.
- [berth](gh:packages/berth/README.md) and [keel](gh:packages/keel/README.md).

## contributing

- [CONTRIBUTING.md](gh:CONTRIBUTING.md) and [DEVELOPING.md](gh:DEVELOPING.md): building, testing and releasing.
- [SECURITY.md](gh:SECURITY.md): reporting vulnerabilities.
- This site's source is in [packages/docs](gh:packages/docs). Its pages describe the release they are built from, and changes to them go live with the next release.
