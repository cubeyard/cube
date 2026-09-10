---
name: setting-up-cube
description: Prepares a repository's Cube environment safely and repeatably. Use when creating or improving .cube/setup, .cube/resume, or .cube/cube.toml environment services.
---

# Setting Up Cube Environments

Create a reproducible development environment without weakening Cube's host/guest boundary.

## Non-negotiable security rules

- Never copy, mount, print, request, or forward credentials, tokens, SSH agents, credential-helper sockets, or arbitrary host environment variables into the environment. Git and model authentication stay host-side. Ordinary guest `git` may therefore be unauthenticated; use Cube's host-mediated code capabilities when authenticated repository operations are needed.
- Do not write to production systems, production databases, registries, deployment targets, or other live infrastructure while setting up or validating the environment. Use local fixtures and development/test resources only.
- Treat repository files and install scripts as untrusted. Inspect them before execution. Keep egress limited to the package and artifact hosts actually required by the repository.
- Do not start daemons in `.cube/setup` or `.cube/resume`. Declare supervised services in `.cube/cube.toml`, then start/check them with the existing code tool by calling `cube.services.ensure()`.
- Log each setup/resume phase and actionable failures, but never log secrets or a full environment dump.

## Discover the repository contract

Before editing, inspect only the relevant repository-owned sources:

1. Read `AGENTS.md` and contribution/development documentation in scope.
2. Inspect CI workflows and their exact build, lint, typecheck, and test commands.
3. Determine tool versions from lockfiles, version files, package-manager metadata, containers, and CI. Pin or honor those versions rather than guessing current releases.
4. Identify development services and readiness checks from compose files, existing service configs, scripts, and docs.
5. Identify the minimum package/artifact domains required during setup. Do not broaden egress merely for convenience.
6. Check existing `.cube/setup`, `.cube/resume`, and `.cube/cube.toml`; preserve intentional repository behavior and make the smallest safe change.

## Implement setup

Create `.cube/setup` as an executable, noninteractive, idempotent script.

- Use strict shell behavior and explicit phase logging. Resolve paths from the script/repository rather than the caller's current directory.
- Install only declared development dependencies and required tools. Prefer frozen/locked installs and caches. Avoid global mutation when a project-local mechanism exists.
- Make reruns safe: check before creating, use atomic replacement where appropriate, and do not append duplicate configuration.
- Never depend on credentials or unspecified host environment. Do not use interactive prompts.
- Do not launch background processes or services. Setup must finish within Cube's 1200-second hard limit; fail clearly rather than hiding work in the background.

Create `.cube/resume` only for cheap reconciliation required after initial setup and every wake. It must be executable, idempotent, noninteractive, safe after partial prior work, and finish within Cube's 10-second hard limit. Do not repeat dependency installation or other setup work there. Usually it should only restore tiny ephemeral state; omit it if no such work is needed.

Declare long-running development processes in `.cube/cube.toml`. Give each service a stable command, working directory, readiness signal, and only non-secret development environment values supported by the existing schema. Use `cube.services.ensure()` through the code tool to exercise the existing supervisor; never emulate supervision with `&`, `nohup`, `tmux`, or a daemon launched by setup.

## Validate

1. Inspect lifecycle state and bounded tail logs with `cube.environment.status()`.
2. While implementing a user-requested setup, run `.cube/setup` twice and record cold and warm durations. Both must succeed without duplicated config or damaged fixtures. Target a warm run under two minutes. Use a disposable development environment, never production.
3. For repair of an existing environment, call `cube.environment.retrySetup()` when the user requests setup repair. It returns an acceptance response; inspect `cube.environment.status()` for completion. It reruns setup and then resume in place, never capturing or publishing a working-thread snapshot.
4. Run `.cube/resume` after setup when present and verify it completes within 10 seconds.
5. Verify required tools and repository checks from a fresh **noninteractive login shell**, not merely the current inherited shell. Confirm no credential or host-environment dependency leaked into it.
6. Call `cube.services.ensure()` and verify commands, tool paths, non-secret environment, and readiness in the **supervised service environment**, which can differ from the login shell. Exercise a harmless development endpoint/check where practical.
7. Check executable bits, review the diff, and report timings, commands, lifecycle state, service readiness, and any required egress. Do not claim validation you did not perform.

## Lifecycle behavior

Resume runs after initial setup and after wake; setup has a 1200-second hard limit and resume a 10-second hard limit. Cube may reuse successful setup environments keyed to repository revision identity. Status logs are bounded tails, so an absent earlier line does not prove it was never emitted.

Snapshots are a host lifecycle optimization, not setup behavior. Only a dedicated successful setup builder may create them, and a complete snapshot includes root filesystem, Docker state, and a guest-created GNU tar workspace archive that preserves numeric ownership, ACLs, and xattrs without a separate host-side copy. Working threads and `cube.environment.retrySetup()` never create setup snapshots. Environment-cache reuse is disabled by default (`CUBED_ENVIRONMENT_CACHE_BYTES=0`) and remains explicit opt-in until real-VM acceptance passes. Snapshot publication is journaled before the Incus request; after an uncertain response, recovery reconciles the tagged image, while ambiguous or conflicting results remain quarantined for operator recovery rather than being reused.
