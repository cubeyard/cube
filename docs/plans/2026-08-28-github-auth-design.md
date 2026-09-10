# GitHub auth for the cube VM — design

Date: 2026-08-28
Status: superseded — GitHub CLI now owns login and credentials; this is a historical design.

## Problem

The VM host is where GitService and `gh` run, and it is deliberately
credential-bearing (ARCHITECTURE §11) — but a fresh install has no git credentials
at all. Mirror-cloning a private repo fails with raw git stderr surfaced to
the user:

    fatal: could not read Username for 'https://github.com':
    terminal prompts disabled

That failure is by design at the git layer (`GIT_TERMINAL_PROMPT=0`,
batch-mode ssh); what is missing is a product-grade way to get a GitHub
credential into the VM and an honest UI state while it is absent.

## Scope

- GitHub first. Generic hosts (GitLab, self-hosted, ssh remotes) can come
  later without reworking this design.
- Credential lives on the VM host only. The invariant is unchanged: nothing
  credential-bearing ever enters a cube.
- The flow lives in the web UI via GitHub's OAuth device flow — unlike pi
  provider auth (which stays "run `pi` over ssh; the UI only reports"),
  GitHub offers a device flow the UI can host without ever handling the
  secret client-side.

## Design

### 1. State and visibility

Git auth becomes a first-class reported state, parallel to pi provider
auth:

- cubed exposes a small auth API:
  - `GET /api/github/auth` → `{ state: "disconnected" | "pending" | "connected",
    login?, pending?: { userCode, verificationUri, expiresAt } }`.
  - The token itself is never present in any API response.
- GitService classifies auth failures (exit code + stderr patterns such as
  `could not read Username` and `Authentication failed`) into a typed
  `auth` failure. The project switchboard renders that as
  **"github: not connected — connect to check this repository"** with a
  `connect github` action — never raw git stderr.
- The header auth area (next to the existing pi AuthBadge) shows
  "github: connected as \<login\>" with a `disconnect` action.

### 2. Connect flow (device flow)

- A registered **cube OAuth app** on GitHub (client id
  `Ov23liubX4AEF6hWNq6O` — public, shippable in source; no client secret
  exists, in the codebase or the VM).
  Scope: `repo read:org workflow` — `gh auth login --with-token` refuses
  tokens without `read:org`, and `workflow` admits pushes touching
  `.github/workflows/`. **"Expire user access tokens" is enabled**: access tokens
  live 8 hours, accompanied by a refresh token valid 6 months without use.
  A leaked access token is worth little; this matches risk register #1
  (host-cred compromise is the top risk).
- `connect github` → `POST /api/github/auth` → cubed calls GitHub's
  device-code endpoint and returns `{ user_code, verification_uri,
  expires_in }`.
- The UI shows the user code large (monospace, Braun-calm), a clickable
  `github.com/login/device` link, and the line
  "enter this code on github — this page updates by itself".
  The UI polls cubed; cubed polls GitHub's token endpoint honoring
  `interval` and `slow_down`.
- Success → "connected as \<login\>"; projects whose checks failed with the
  `auth` classification get a natural `check again`.
- Expired code (~15 min) → "code expired — start again". Calm state, not
  error styling (waiting is a state, not a failure).

### 3. Storage — one source for both consumers

The access token is written into **gh's credential store** (equivalent of
`gh auth login --with-token` on stdin), followed by a one-time
`gh auth setup-git`. This gives:

- git-over-https via gh acting as git credential helper (configured
  globally in the VM — note: GitService's runner env pins config sources to
  defeat repo-local helpers; the global gh helper must be explicitly
  verified/allowed in that env, see Risks),
- the `gh pr create` flow using the same token,
- exactly one thing to delete on disconnect.

The **refresh token** cannot live in gh's store (it only holds the access
token), so cubed stores it itself: a mode-0600 state file on the data disk,
never exposed over the API. cubed owns refresh, mirroring the existing pi
pattern (proactive refresh at low remaining validity, under a file lock,
rotated credential persisted): on use or on a timer, when the access token
is near expiry, exchange the refresh token for a new pair, persist the new
refresh token, and rewrite the access token into gh's store.

`~/.config/gh` joins `~/.pi` on the data-disk persistence path (survives
OS-disk upgrades) — that work is already planned in ARCHITECTURE §13 "Still in
phase".

### 4. Failure honesty

- Disconnect deletes both tokens from the VM and says exactly that:
  "removes the tokens from this machine — the grant stays on github until
  you revoke it there" (device-flow tokens cannot reliably be revoked via
  API without a client secret).
- A dead credential (grant revoked, or the refresh token expired after
  6 months of disuse / rejected with `bad_refresh_token`) is discovered at
  the next refresh, repo check, or push, classified back to
  `disconnected`, and shows the same connect CTA. No separate health-check
  daemon.
- Network failure during device flow → "couldn't reach github — check the
  VM's network", with retry.

### 5. Testing

- GitService: unit tests for auth classification from fixtures of real git
  stderr.
- Device flow: cubed tests against a mock of GitHub's endpoints
  (pending → slow_down → success, code expiry, and token refresh incl.
  `bad_refresh_token`).
- UI: disconnected / pending / expired / connected states in the
  switchboard and badge.

## Risks / open points

- GitService's hardened runner env (`GIT_CONFIG_*` pinning) may currently
  exclude the global gh credential helper along with the hostile ones. The
  implementation must thread the gh helper through explicitly (e.g. inject
  `credential.helper` via `-c` in the pinned command line) rather than
  loosening the pinning.
- The OAuth app is owned by the project author's GitHub account; the client
  id is public and shippable in source.
- The `repo read:org workflow` scope is broad (classic OAuth app scopes
  have no per-repo narrowing). Accepted for v1; fine-grained alternatives (GitHub App
  installation) are a later evolution if scope narrowing matters.
