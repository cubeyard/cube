# Authorization: passkey sign-in, Biscuit grants, runner-bound tokens, approvals

Status 2026-10-15: research, spikes and plan. Nothing is built beyond the
spikes in `spikes/2026-10-15-authorization/` and the fixtures in
`packages/runner-protocol/fixtures/authz/`. The order of work was fixed in
advance: an authority inventory from code (appendix A), traffic captured at
a real protocol-4 gate (appendix B), primary specifications (appendix D),
then four spikes with thresholds written down before measuring (appendix C,
thresholds fixed 2026-10-15 19:03 CEST). This plan is constrained by those
results. Where a spike missed its threshold, the design changed; the miss
and the change are both stated. Protocol 4 (`berth`) only: protocol 3
(`cube-runner`, `cube-gateway`'s per-request decisions) is on its way out
and stays as it is.

Scope is four things and no more: passkey sign-in, Biscuit grants,
runner-bound tokens, approvals. Out of scope and stated as such:

- per-command policy inside the guest: the guest is the sandbox, not a
  boundary inside it;
- `berth host`: unsandboxed by design (AGENTS.md), no gate, nothing here is
  claimed as enforced there;
- multi-user: the schema leaves room for it, nothing more;
- user authentication as a replacement for network controls: AGENTS.md's
  rule stays (loopback, an authenticated proxy or an access-controlled
  private network). The maintainer intends to host cubed on the internet
  once authn and authz are in place; that is a separate decision with its
  own threat model ("Open", item 1). This plan is designed so that its
  controls do not depend on the network being private, but it does not
  claim that cubed is ready to be public.

## What exists today

All of this is from code at 744c91299; appendix A is the full inventory
(104 routes, 26 runner stream rows, 21 secret reads, 27 gaps) with every
citation checked.

- **No user authentication.** The TCP API (`packages/server/src/index.ts:470-817`)
  checks only the Host header against an allow-list (`:281-282`, `:476`)
  and, when an `Origin` header is present, that it matches Host (`:477`).
  Anyone who can reach the listener can start threads, replace model
  credentials (`:542-554`), bind or log out the host's gh
  (`packages/server/src/github-auth.ts:195-199`, `index.ts:560`), confirm
  merges by echoing `owner/repo#n` (`packages/server/src/artifact-service.ts:321,330`)
  and take a thread's workspace lease when none is held, then run commands
  in its machine (`index.ts:780-781`, `packages/server/src/workspace-http.ts:57-62`).
  `GET /api/threads` returns every thread's vm id and GitHub placeholder
  (`index.ts:742`).
- **Protocol-4 egress is decided on the runner, allow-all.** cubed sends an
  `EgressPolicy` with every `machine_start`
  (`packages/server/src/egress-policy.ts:71-81`): `ALLOW_PUBLIC_HTTP`, no
  deny hosts, one credential rule per held secret, a 15-minute lease
  (`:79`). berth enforces it per HTTP request
  (`packages/berth/src/vm/egress.rs:384`, `packages/berth/src/vm/policy.rs:278`);
  only requests that match a credential rule reach cubed.
- **The GitHub token has no method, path, repository or ref rule.** On
  protocol 4 a credential-rule request goes over a `credential` stream
  (`packages/runner-protocol/proto/runner.proto:634`, `egress.rs:403-498`)
  to cubed, which checks the thread, the runner's admission and the fence
  (`packages/server/src/runner-credentials.ts:41-63`) and splices it to
  cube-gateway's credential proxy, which substitutes the token when the
  placeholder belongs to the VM, over HTTPS, to `github.com` or
  `api.github.com` (`egress-policy.ts:92-110`). Every thread gets a
  placeholder (`packages/server/src/registry.ts:787`). So a push to `main`, a
  tag push, a merge or a contents write all go out.
- **Runner identity is the Iroh key; there is no revocation.** Enrollment
  is a host CLI (`index.ts:957-969`, `packages/server/src/runner-enroll.ts:32-49`)
  that checks only the hello's node id for protocol 4
  (`packages/server/src/runner-session.ts:217`); nothing is written to
  `runner_audit` on enrollment (`registry.ts:378-385`); retiring a runner
  leaves its keys trusted.
- **cubed's own processes share one Unix user.** Pi, the codemode worker and
  the Claude Code child can use every 0600 socket in `CUBED_STATE/run`;
  `egress.sock` returns the plaintext token for a vm id, thread id and
  placeholder (`egress-policy.ts:147-169`).
- **Documents that disagree with the code** are listed in appendix A, F.
  The two that matter here: SECURITY.md and docs/security.md say cubed
  decides every guest request and that HTTPS is intercepted with the
  installation CA; on protocol 4 the runner decides and intercepts with its
  own CA (`packages/berth/src/vm/ca.rs:1-24`).

## What the evidence says

Four results shape the design more than any preference.

1. **Passkeys work on `http://localhost` and on HTTPS by name with a
   trusted certificate, nowhere else** (spike 4d, appendix C). The
   documented `http://127.0.0.1:7777` fails ("This is an invalid domain"),
   and so does a tailnet IP over plain HTTP (not a secure context, and
   Secure cookies are dropped). Chromium refuses WebAuthn on a page with a
   certificate error, also after clicking through. A reverse proxy works
   only when cubed checks a configured origin, never one derived from Host.
   Passkeys are bound to the RP ID, so the name chosen now carries forward.
2. **A gate can derive the policy's facts from real traffic, with three
   exceptions** (appendix B, 87 requests at berth's gate, 25 scenarios):
   - git smart HTTP gives repository, ref, old and new object id per ref
     update, in plaintext pkt-lines before the pack; pushes are always
     protocol v0 and were never compressed; fetches are v2 and gzip their
     larger requests, which does not matter because a fetch is decided by
     its path;
   - GitHub REST gives an OpenAPI operation from method and path, but the
     ref a write moves may be in the JSON body (`contents` PUT's `branch`,
     `git/refs`' `ref`/`sha`), and absent means the default branch;
   - GitHub GraphQL cannot be judged by `operationName`. gh's documents
     use fragments; mutations name their target by node id
     (`createPullRequest(input: {repositoryId: "R_…"})`). Decided: GraphQL
     queries get one coarse grant; mutations are denied except an
     allow-list whose node ids cubed's proxy resolves. Merges are denied
     to agents (the user merges through cube's existing confirmed merge).
3. **Biscuit is fast enough per action, not per many actions** (spike 4a).
   Per action p99 0.23-0.41 ms at moderate host load and token
   verification p99 0.45-0.61 ms, against 1 ms. But one authorization per
   ref update is required (checks are existential), and a 50-ref push took
   p99 13-15 ms: **fail**. Under heavy load on this shared host single
   actions reached p99 1.69-5.5 ms, and biscuit-auth's default 1 ms time
   limit denied up to 1.4 % of valid requests: a robustness **fail**.
   Rust and TS agree on all 42 shared fixtures, in both directions
   (spike 4b, extended for this plan's leaf, deny and plain-HTTP shapes),
   and the draft approval shape had to change because a derived fact
   inherits the approval block's origin.
4. **Revocation over protocol 4 is sub-millisecond when connected**
   (spike 4c): send to refusal p99 0.42-0.88 ms on loopback, 27.5-56 ms
   through an n0 relay, 13 300 of 13 300 delivered, against p99 < 1 s.
   Two caveats: the existing call path stalls for its whole 15 s timeout
   about once per 65 000 calls (`openBi` in `@number0/iroh` 1.1.0, not
   root-caused), and a disconnected runner keeps its policy for about
   33 s (QUIC idle) plus the lease, 15.5 minutes today.

Design changes these results force (each has a test in "Tests"):

| result | change |
|---|---|
| 4a: 50 ref updates in one push, p99 13-15 ms | a push carries at most **2** ref updates; more is refused with `x-cube-denied: push at most 2 refs at a time` (git then fails visibly; agents push branch by branch) |
| 4a: per-action tails under load, default 1 ms limit denies valid requests | explicit run limits (`max_time` 20 ms, `max_facts` 1000, `max_iterations` 100) on both sides; plain HTTP is authorized on `(host, method)` without the path, and the verdict is cached per token revision and `(host, method)` until the token's expiry or a revocation |
| 4a: biscuit-auth 6 cannot add facts to a built authorizer | the per-flow authorizer cache is dropped (it saved only 15 %) |
| 4b: draft approval shape always denied | final shape below: grants only in authorizer policies; the approval requirement is an authority check whose approval alternatives alone trust the approval key |
| 4b: biscuit-wasm seeds every key, also each block's next key, from 8 random bytes (`src/crypto.rs:213-216` at 80cceed) | root and approval keys are generated with `node:crypto` and imported; the next keys matter too (a runner that recovered the secret dropped behind its leaf's TTL block could append a different last block), so cubed uses biscuit-wasm only with a 32-byte seed (a one-line change, upstream or in a pinned build) and T3 checks the build it runs |
| 4b: first authorization in a fresh Node process takes 30-55 ms and trips biscuit-wasm's 20 ms default | cubed does not evaluate with biscuit-wasm on a request path; it mints, attenuates and signs approvals; evaluation is Rust in berth and cube-gateway; TS evaluates only in the fixture parity test, with `authorizeWithLimits` |
| 4c: disconnected bound 15.5 min | the delivered token's TTL replaces the lease: **5 minutes**, renewed every 2.5 minutes over the call stream |
| 4c: 15 s stall in the call path | revocation is retried by generation and, if unanswered, cubed closes the connection (which starts the TTL); the stall itself is "Open", item 5 |
| 4d: IP origins and plain HTTP off localhost fail | `CUBED_ORIGIN` is required for auth; the default local URL becomes `http://localhost:7777`; the tailnet-IP recipe in DEVELOPING.md and docs/security.md is replaced by HTTPS by name |
| spec: a WebAuthn challenge must be random (WebAuthn L3 §13.4.3) | a step-up challenge is 32 random bytes followed by SHA-256 of the action, not the bare digest |
| spec: a passkey cannot sign a Biscuit block (Biscuit SPECIFICATIONS.md, third-party signature payload) | cubed verifies the assertion, stores it as evidence, then signs the approval block with the approval key |

## Principles

1. **One grant, two evaluators, one implementation.** A thread machine's
   authority is one Biscuit. berth's gate and cube-gateway's credential
   proxy evaluate the same token with the same Rust crate; cubed (TS) only
   mints, attenuates and signs.
2. **Unknown is denied.** A request the gate cannot reduce to actions, an
   action the token does not grant, a GraphQL mutation not on the
   allow-list, a REST write whose ref cannot be named: denied, with
   `x-cube-denied` and a report.
3. **Approval can never exceed the profile.** Only facts signed by the
   approval key can satisfy an approval requirement, and nothing signed by
   that key can add a grant.
4. **The token never enters the guest, and the credential never enters
   the runner.** The runner holds the token in memory; the GitHub token
   stays in cubed's proxy, as today.
5. **Identity stays where it is.** A runner is its Iroh key; a user is a
   passkey; a thread machine is its vm id and fence epoch. Biscuit binds
   these together and does not replace any of them.
6. **Every claim has a test that can fail.** A claim without one is in
   "Open" or not in this plan.

## Design

### 1. Sign-in: one owner, several passkeys

- **Origin.** `CUBED_ORIGIN` is one origin (`http://localhost:7777`, or
  `https://<name>`). Auth refuses to start without it, and cubed then
  refuses to serve the API. The RP ID is the origin's host;
  `CUBED_RP_ID` may name a registrable parent (e.g. `example.com` for
  `cube.example.com`) and must be a suffix that is not a public suffix.
  The Host allow-list is derived from the origin. cubed never derives an
  origin from `Host` or `X-Forwarded-*`.
- **Accounts.** Tables in `registry.sqlite`: `users(id, handle, created_at)`
  where `handle` is only the WebAuthn `user.name`/`displayName` label; no
  email. `credentials(id, user_id, public_key, sign_count, aaguid,
  backup_eligible, backup_state, transports, label, created_at,
  last_used_at)`. Projects, threads, runners and approvals get an
  `owner_user_id` set to the single owner, and Biscuit's `on_behalf_of` is
  that id: multi-user later needs no migration of these rows.
- **First device.** `cubed auth setup` on the host prints a one-time
  setup code (16 random bytes, base32, valid 15 minutes, stored as a hash).
  The setup page takes the code and runs registration with
  `residentKey: "required"`, `userVerification: "required"`. The server
  checks type, challenge, origin, rpIdHash, UP and UV itself.
- **Sign-in.** Discoverable: `allowCredentials: []`, the user handle maps
  to the user, UV required and checked.
- **Sessions.** Server-side: a 256-bit random id in
  `__Host-cube_session` (`Secure; HttpOnly; SameSite=Strict; Path=/`), its
  SHA-256 in `sessions(id_hash, user_id, created_at, last_seen,
  expires_at, step_up_at)`. Idle 7 days, absolute 30 days, renewed on
  sign-in. Every API route requires a session except `/api/auth/*` and
  static files. A state-changing request also needs
  `Origin == CUBED_ORIGIN` (a missing Origin is refused, closing today's
  gap at `index.ts:477`) and JSON as today.
- **More devices.** From a signed-in session: a fresh UV assertion (step-up
  within 5 minutes), then a registration with `excludeCredentials`.
- **Recovery.** `cubed auth reset` on the host removes every credential and
  session, keeps the user and ownership, and prints a new setup code. The
  host shell is the root of trust; nothing else resets.
- **Workspace socket.** Unchanged (lease tokens on a 0600 socket). The TCP
  route to it (`index.ts:780`) now requires a session.

### 2. Grants: Biscuit

**Keys.** Two Ed25519 keys generated with `node:crypto`, imported into
biscuit-wasm, stored 0600 under `CUBED_STATE/keys/`: the **root key**
(mints authority blocks) and the **approval key** (signs third-party
approval blocks only, and only after an approval is recorded). Each has a
numeric id. The root key's id is the token's `root_key_id`; the approval
key is named in the authority block by its public key
(`trusting ed25519/<public key>`), so rotating it means minting new bases.
Rotation adds a key with a new id; both are accepted during an overlap; the
old one is then removed from the runners' key set (`grant_keys`).

**Authority block** = project profile ∩ owner, minted by cubed per thread
machine:

```
on_behalf_of("user:1"); project("p1"); thread("t1");
runner("<berth's Iroh node id>"); machine("<vm id>");
http("registry.npmjs.org", "GET"); …                       // profile ∩ user
git("github.com", "owner/repo", "fetch");
git_push_prefix("github.com", "owner/repo", "refs/heads/cube/t1/");
git_delete_prefix("github.com", "owner/repo", "refs/heads/cube/t1/");
git_push_approval("github.com", "owner/repo", "refs/heads/main");  // needs approval
github_api("owner/repo", "read"); github_api("owner/repo", "pulls/create");
github_graphql("query", "*"); github_graphql("mutation", "createPullRequest");
check if time($t), $t <= <grant expiry>;
check if peer($p), runner($p);
check if vm($v), machine($v);
check if req_http($h, $m) or req_git_fetch($h, $r) or req_github_api($r, $op)
  or req_github_graphql($k, $f)
  or req_git_push($h, $r, $ref, $o, $n), git_push_prefix($h, $r, $p), $ref.starts_with($p)
  or req_git_push($h, $r, $ref, $o, $n), git_delete_prefix($h, $r, $p), $ref.starts_with($p)
  or req_git_push($h, $r, $ref, $o, $n), approved($h, $r, $ref, $n) trusting ed25519/<approval key>
  or req_git_push($h, $r, $ref, $o, $n), approved_ref($h, $r, $ref, $exp), time($t), $t <= $exp
     trusting ed25519/<approval key>;
```

**Authorizer** (fixed by cubed, the same in gate and proxy, default scope:
authority and authorizer only; it never trusts the approval key):

```
allow if req_http($h, $m), http($h, $m);
allow if req_git_fetch($h, $r), git($h, $r, "fetch");
allow if req_github_api($r, $op), github_api($r, $op);
allow if req_github_graphql("query", $f), github_graphql("query", "*");
allow if req_github_graphql("mutation", $f), github_graphql("mutation", $f);
allow if req_git_push($h, $r, $ref, $o, $n), git_push_prefix($h, $r, $p), $ref.starts_with($p), $n != <zero>;
allow if req_git_push($h, $r, $ref, $o, $n), git_push_approval($h, $r, $ref), $n != <zero>, $n != "unknown";
allow if req_git_push($h, $r, $ref, $o, $n), $n == <zero>, git_delete_prefix($h, $r, $p), $ref.starts_with($p);
```

The gate supplies `peer(<its own node id>)`, `vm(<machine>)`, `time(now)`
and exactly one `req_*` fact per action. A push to an approval-gated ref
passes the authorizer's `allow` but fails the authority check until an
approval block for that exact ref and object id is present; a push outside
the profile fails the `allow`, whatever approval exists (fixture
`approval-outside-profile-ref-denied`). Revocation is checked before
Datalog, against the token's per-block revocation ids (biscuit-auth 6 does
not generate the spec's `revocation_id` facts).

**Lifetime: the grant, not the session.** cubed keeps the **base token**
(authority block, then approval blocks as they come) and never sends it.
What the runner gets is a **leaf**: the base plus one attenuation block
`check if time($t), $t <= <now + 5 min>`. A holder cannot remove a block
from a Biscuit, and the runner never sees a base, so the leaf's TTL holds.
Renewal is a new leaf every 2.5 minutes over the call stream; the authority
block's own expiry is the grant's (the thread's) lifetime. A sign-out does
not end a thread's grant; archiving the thread or a revocation does.

**Task scope by attenuation.** A narrower task (OptChat `spawn` of a
sub-task, or a task the user starts with a narrower scope) gets a base that
is the parent's base plus an attenuation block of checks only, for example
`check if req_git_push($h, $r, $ref, $o, $n), $ref.starts_with("refs/heads/cube/t1/a/") or req_git_fetch($h, $r) or req_http($h, "GET");`.
OptChat's `spawn` can only append such blocks: it has no access to the
root key's minting function (a separate module the tool cannot import),
and the spawn path is tested to produce a token whose verdicts are a
subset of its parent's on the corpus.

**Revocation.** Revoking a base's authority-block id ends the grant and
every leaf and attenuation under it; revoking a leaf's TTL-block id ends
that leaf only. cubed sends `grant_revoke` (below) to every connected
runner and keeps the revoked set until the ids' tokens would have expired.

### 3. Enforcement on protocol 4

**What changes on the wire** (a sketch; `runner.proto` is the reference
once built):

```proto
message MachineStart { …; reserved 5; Grant grant = 6; }  // replaces EgressPolicy policy = 5
message Grant { bytes leaf = 1; uint64 generation = 2; }
// Call verbs
GrantUpdate grant_update = 30;   // { Ref ref; Fence fence; Grant grant; }  renewal, approvals, attenuation
GrantRevoke grant_revoke = 31;   // { repeated string ids; uint64 generation; bool full; }
GrantKeys   grant_keys   = 32;   // { repeated Key root; repeated Key approval; } Key { uint32 id; bytes ed25519; }
// Report (runner -> cubed, the existing report path)
ApprovalNeeded { Ref ref; string pending_id; bytes action; bytes digest; }
```

`grant_keys` is sent after every hello, before any `machine_start`; a
berth without keys refuses to start machines. The revoked set is
runner-wide, in memory, separate from the policy (spike 4c: rebuilding a
policy with 100 000 ids inside costs 7.5 ms per revoke; a separate set
costs 170 ns), and cubed sends it in full after every hello.

**The gate** (`packages/berth/src/vm/egress.rs`). Per HTTP request, after
the existing lease, CONNECT/Upgrade, Host = SNI and address checks:

1. reduce the request to actions with the shared crate (below); unknown is
   a denial;
2. a push with more than 2 ref updates is a denial;
3. revoked ids, then the leaf's signature (once per leaf) and Datalog per
   action, with the explicit run limits; plain HTTP verdicts come from the
   cache when present;
4. an action that fails only the approval check is **held**: the gate sends
   `ApprovalNeeded` and waits up to 60 seconds for a `grant_update` that
   satisfies it; then it re-evaluates, or answers 403 with
   `x-cube-denied: approval pending <id>`;
5. allowed requests go out as today: upstream, or the credential stream for
   a credential-rule host.

**The shared crate** (`packages/grant`, `cube-grant`, used by berth and
cube-gateway): pkt-line reader (40- and 64-hex ids, `shallow` and
`push-cert` refused, a body limit), the GitHub REST table generated from a
pinned `github/rest-api-description` (operation by method and path; a
trailing `{ref}` or `{path}` may span segments; the body's `ref`, `branch`,
`base`, `sha` read for writes; a ref write without a nameable ref is
denied), a GraphQL reader (a real parser, exactly one operation, fragments
resolved for top-level fields, one top-level field per request for
mutations), the authorizer and the verdict cache. The spike's TypeScript
version is `spikes/2026-10-15-authorization/capture/facts.ts`.

**cubed's credential proxy.** Two changes, both on cubed's host:

- `runner-credentials.ts` adds to its checks that the connection's Iroh
  peer is the runner the thread is placed on, and passes to cube-gateway
  the thread's **current leaf from cubed's own store** (never one the
  runner supplies) and that peer id;
- cube-gateway's credential path (`packages/gateway/src/credential.rs`,
  `http.rs`) reduces the request to actions with the same crate and
  evaluates the leaf with `peer = the connected runner`. For GraphQL
  mutations on the allow-list it resolves the node id (`repositoryId`,
  `pullRequestId`) with the token it already holds and adds
  `req_github_target(repo)`; a mutation whose target is not a project
  repository is denied.

Protocol 3's `EgressPolicy.decide` stays as it is.

### 4. Approvals

- **Needs approval** is a fact the profile sets (`git_push_approval`), so
  the gate can tell "denied" from "held". The default profile puts the
  repository's default branch and protected branches behind approval and
  denies tags and deletions outside the thread's prefix outright.
- **What the user sees** is cubed's approval view: the thread, the action
  (repository, ref, old and new object id, the commits between them as
  cubed's host git can read them), and the four choices. The authenticator
  shows nothing of the action (WebAuthn L3 dropped transaction display), so
  that view is what is approved.
- **Allow once**: an approval block `approved(host, repo, ref, sha)`. It
  binds the exact object id, so it cannot be used for any other push.
- **Allow for this thread**: `approved_ref(host, repo, ref, expiry)` with
  the thread grant's expiry.
- **Always**: a change to the project profile (adds the ref to
  `git_push_prefix` or removes the approval requirement), itself behind a
  step-up assertion; new bases are minted and the old ones revoked.
- **Deny**: an attenuation block `reject if req_git_push($h, $r, $ref, $o, $n), $ref == "<ref>";`
  appended to the base, a new leaf sent, and the previous leaf's id
  revoked, so the denial holds even for a runner that keeps the old leaf.
- **Step-up.** Approvals of high-impact actions (a push or REST ref write
  to an approval-gated ref, a profile change, adding a device, enrolling a
  runner) need a fresh assertion with UV. The challenge is 32 random bytes
  followed by SHA-256 of the action's canonical JSON; it is single-use and
  valid 5 minutes. The server checks the challenge's digest half against
  the pending action before signing anything, and stores the assertion
  (authenticatorData, clientDataJSON, signature, credential id) with the
  approval as evidence.
- **Replays.** An approval block is bound to its token (it signs the
  previous block's signature), so it cannot move to another thread's
  token; on its own token it can only approve the same ref and object id
  again. A step-up challenge is used once.

### 5. Runner enrollment

`cubed runners enroll --config …` stays the host-side entry, but it now
ends in a **pending** enrollment. The UI shows the runner's node id, kind,
protocol and labels; the user approves with a step-up assertion whose
challenge carries SHA-256 of exactly those values. Only then is the runner
row written, with a `runner_audit` entry holding the assertion. Runner
identity stays the Iroh key; enrollment does not issue a Biscuit to the
runner (the runner receives leaves per machine).

## Threat model

Five enforcement points; for each, the attackers that can reach it and what
stops each leaf. "Test" names an entry in "Tests". Incidents are those of
the Secure Software Factory paper (agentbaseline.org, 2026-10-13, p. 26):
**P** = PocketOS (an agent used a found API token to delete a production
volume), **L** = "Let's land #118" (an agent pushed a version tag that
started a production deploy), **S** = Shai-Hulud (an npm worm stealing
tokens and publishing from developer machines).

### Runner gate (berth vm)

| leaf | control | test | covers |
|---|---|---|---|
| hostile guest pushes to `main` | authority check needs an approval block for that sha; held then 403 | T1a | L |
| hostile guest pushes a release tag | tags not granted | T2 (`git-push-tag`) | L |
| hostile guest pushes many refs to hide one | at most 2 refs per push; each ref authorized | T4, T2 | |
| hostile guest moves `main` through REST (`PATCH git/refs/heads/main`, `PUT contents` without `branch`) | REST ref writes are push actions; no nameable ref is a denial | T2 (`gh-api-rest-write-ref`), T4 | L |
| hostile guest merges a PR through GraphQL | `mergePullRequest` not on the allow-list | T2 (`gh-pr-merge`) | |
| hostile guest uses any other GitHub mutation | mutation allow-list | T2 (`gh-api-graphql-mutation`) | |
| hostile guest sends a malformed pkt-line or GraphQL body to confuse the parser | parsers refuse; fuzzed; refusal is denial | T4 | |
| hostile guest publishes a package (npm PUT, POST) | only granted `(host, method)` | T2 (`npm-install-audit` POST denied) | S |
| hostile guest uses a found third-party token (Railway, cloud) | the host is not granted; real secrets never enter the guest | T2, existing leak scan | P |
| compromised runner replays a leaf on another runner | `runner(...)` vs the gate's own node id | T1c | |
| compromised runner forges or widens a token | signature with cubed's root key; attenuation only narrows | T3 | |
| compromised runner strips its leaf's TTL or deny block | blocks cannot be removed without the dropped block's secret; keys from 32 random bytes | T3 (I23) | |
| compromised runner ignores its own gate | non-credential egress from that runner is not enforced (accepted, below); credential requests are re-evaluated by cubed's proxy | T1c | |
| revoked grant still used | revoked set before Datalog; connected p99 < 1 s | T1f, T6 | |
| runner cut off from cubed keeps a leaf | leaf TTL 5 min | T1g | |

### cubed's credential proxy

| leaf | control | test | covers |
|---|---|---|---|
| runner sends a credential stream for a machine placed elsewhere | peer = placed runner, and `runner(...)` in the leaf | T1c | |
| runner sends a request the gate would deny | the proxy evaluates cubed's own leaf | T1a (proxy side), T1c | L |
| GraphQL mutation targets another repository by node id | proxy resolves the node id; target must be a project repository | T5 | |
| runner supplies its own token | the proxy uses cubed's store, never the runner's | T1c | |

### cubed API and session

| leaf | control | test | covers |
|---|---|---|---|
| network peer calls the API without signing in | session required on every route but `/api/auth/*` | T7 | P |
| stolen session cookie | HttpOnly, Secure, SameSite=Strict; server-side, revocable; high-impact actions need a fresh UV assertion, which a cookie cannot give | T7 | |
| cross-site request | SameSite=Strict, Origin = `CUBED_ORIGIN` required on writes | T7 | |
| sign-in without user verification | UV checked on the server | T7 | |
| DNS rebinding | Host allow-list derived from `CUBED_ORIGIN` | T7 | |

### Approval path

| leaf | control | test | covers |
|---|---|---|---|
| approval block signed with another key | `trusting ed25519/<approval key>` only | T1d, T3 | |
| approval for sha A used for sha B | `approved(..., $n)` binds the object id | T1e, T3 | |
| approval used to widen the profile | grants live only in non-trusting authorizer policies | T3 (`approval-key-cannot-widen-profile-denied`) | |
| replayed step-up assertion | single-use challenge with the action digest | T7 | |
| assertion for one action used for another | digest half of the challenge checked against the pending action | T7 | |
| holder forges approval facts in an attenuation block | default scope does not trust attenuation blocks | T3 (`attenuation-cannot-forge-approval-denied`) | |

### Runner enrollment

| leaf | control | test | covers |
|---|---|---|---|
| a host process enrolls a rogue runner | enrollment pending until a step-up approval of its node id | T8 | |
| enrollment approved for a different node id than shown | the challenge carries the node id's digest | T8 | |

### Accepted risks

- **A compromised runner host has its own network.** Egress that does not
  use a credential leaves from the runner; a runner that ignores its gate
  can send what it likes for its machines. The runner already runs QEMU
  and sees guest traffic in plaintext (AGENTS.md); Biscuit does not change
  that. Credential use stays enforced at cubed.
- **Exfiltration over granted reads.** A guest can encode data in GET paths
  to a granted host, or in a pull request body. Reads are granted by host,
  not path (spike 4a forced that).
- **GraphQL and REST reads reach every repository the GitHub token can.**
  The gate cannot tell a node id's repository, and resolving every read
  would double GitHub traffic. The remedy is a narrower credential
  (a fine-grained token or GitHub App installation per project), outside
  these four items ("Open", item 3).
- **A compromised cubed is total.** Pi, the codemode worker, the Claude Code
  child and cubed's own npm dependencies run as cubed's user and can read
  the root and approval keys (S, applied to cubed's own build). Moving the
  keys into a separate signer process is "Open", item 2.
- **The approval view is trusted.** What the user approves is what cubed
  renders; a compromised cubed can show one thing and sign another.
- **A 15 s revocation tail** while the call-path stall exists (spike 4c),
  bounded by the 5-minute TTL in the worst case.

## Invariants

Each invariant names the test that proves it. A claim not listed here is
not claimed.

| # | invariant | test |
|---|---|---|
| I1 | a push to an approval-gated ref without an approval block for its object id is held, then denied | T1a, T2 |
| I2 | a push under the thread's prefix is allowed without approval | T1b, T2 |
| I3 | a leaf evaluated on any runner but its own is denied, at the gate and at the proxy | T1c |
| I4 | an approval block not signed by the approval key satisfies nothing | T1d, T3 |
| I5 | an approval for object id A does not allow object id B | T1e, T3 |
| I6 | a revoked grant is denied within the measured revocation latency (p99 < 1 s connected) | T1f, T6 |
| I7 | a runner that cannot renew is denied once its leaf's TTL has passed | T1g |
| I8 | every corpus request gets its expected verdict, and every unclassifiable request is denied | T2 |
| I9 | Rust and TS give the same verdict on every shared Datalog fixture | T3 |
| I10 | malformed pkt-line or request bodies never panic and never allow | T4 |
| I11 | a push with more than 2 ref updates is denied | T4, T1b |
| I12 | an approval cannot grant what the profile does not | T3 |
| I13 | an attenuation block narrows and never widens | T3, T5 |
| I14 | a GraphQL mutation outside the allow-list, or on a node outside the project, is denied | T2, T5 |
| I15 | every API route but `/api/auth/*` needs a session; writes need `Origin == CUBED_ORIGIN` | T7 |
| I16 | sign-in and step-up are refused without UV | T7 |
| I17 | a step-up assertion is valid once, for one action digest | T7 |
| I18 | a runner is not admitted without a step-up approval of its node id | T8 |
| I19 | the token and the GitHub token never appear in the guest | T1 (leak scan, as `leak-scan-test.ts`) |
| I20 | per-action authorization stays under its thresholds (appendix C) | T6 |
| I21 | a user's deny holds even with an earlier approval for the same ref | T3 (`deny-reject-block-denied`), T1 |
| I22 | a leaf past its TTL is denied while the grant is valid, and approvals survive renewal | T3 (`leaf-ttl-expired-denied`, `leaf-ttl-approval-after-ttl-allowed`), T1g |
| I23 | every key cubed generates or has biscuit-wasm generate comes from at least 32 random bytes | T3 |

## Tests (implementation step 1)

These are written first, against the interfaces above; each work package
turns its tests from pending to required. All run offline except T1, which
needs Linux with KVM.

- **T1** `packages/server/test/authz-vm-test.ts`, run by
  `CUBE_TEST_VM=required bash scripts/test-node-transport.sh` (which then
  also requires the `CUBE_TEST_BERTH_*` environment, see "Open", item 4):
  cubed's real code, a real `berth vm`, a keel machine, the disposable
  GitHub fake of `scripts/fake-github.ts`. The guest tries:
  a) `git push origin HEAD:main` without approval: held, then 403
     `x-cube-denied` after 60 s; with an allow-once approval for that sha
     sent during the hold: pushed;
  b) a push to `refs/heads/cube/<thread>/x`: allowed; three refs at once:
     denied;
  c) the machine's leaf handed (through a test-only call) to a second
     berth vm, which tries a request: denied by its gate; a credential
     stream from the second runner for the first machine: denied by the
     proxy;
  d) an approval block signed with a key other than the approval key:
     denied;
  e) an allow-once approval for sha A, then a push of sha B: denied;
  f) a revocation of the base: the next request denied, timed against
     T6's latency;
  g) cubed's session closed with a test TTL of 20 s: denied after the TTL;
  and a leak scan of the guest for the leaf's and the GitHub token's bytes.
- **T2** `packages/grant/tests/corpus.rs` and
  `packages/server/test/authz-corpus-test.ts`: replay
  `packages/runner-protocol/fixtures/authz/corpus/p4-berth-gate.jsonl`
  against `p4-berth-gate.expected.json` (appendix B): every request its
  expected verdict, every unclassified action denied.
- **T3** `packages/grant/tests/datalog.rs` and
  `packages/server/test/authz-datalog-test.ts`: every fixture in
  `packages/runner-protocol/fixtures/authz/datalog/` (42 today) minted and
  evaluated in Rust and in TS, both directions; equal verdicts. It also
  fails when cubed's biscuit-wasm build seeds keys from fewer than 32 bytes
  (the build's digest is pinned to one with the fix, and the test mints two
  tokens under a stubbed `crypto.getRandomValues` returning the same first 8
  bytes and different rest, which must give different block keys).
- **T4** `packages/grant/fuzz` (cargo-fuzz targets `pkt_line`,
  `request_facts`) and `packages/grant/tests/props.rs` (proptest): no panic;
  any input that is not a well-formed command list is denied; more than 2
  ref updates denied; corpus bodies with one byte changed never become
  more permissive.
- **T5** `packages/server/test/authz-mint-test.ts`: OptChat `spawn` produces
  tokens whose verdicts on the corpus are a subset of the parent's; GraphQL
  node ids outside the project are denied by the proxy (fake GitHub
  resolving ids).
- **T6** `packages/grant/benches/gate.rs` and
  `scripts/authz-revoke-timing.ts`: the spike measurements as checks,
  recorded with the host's load: per action p99 < 1 ms, verification
  p99 < 1 ms, cached plain-HTTP p99 < 50 µs, revocation p99 < 1 s with
  100 % delivery.
- **T7** `packages/web/test/browser/auth-browser-test.ts` (in
  `pnpm test:browser`, Playwright with CDP `WebAuthn.addVirtualAuthenticator`)
  and `packages/server/test/auth-session-test.ts`: setup code, registration,
  sign-in, adding a device, step-up over a digest (and its reuse refused),
  `cubed auth reset`, rejection without UV, cookie flags, missing Origin
  refused, cubed refusing to start auth without `CUBED_ORIGIN`. Note: a
  virtual authenticator bypasses Chromium's certificate-error refusal, so
  T7 runs on `http://localhost` and does not prove TLS handling.
- **T8** `packages/server/test/runner-enroll-approval-test.ts`: enrollment
  stays pending without an assertion; an assertion over another node id is
  refused; an approved one writes `runner_audit`.

Today's spike numbers recorded against their thresholds are in appendix C.

## Smallest next step

Work package 0, in one PR: T2, T3 and T4 against a new `packages/grant`
crate that holds only the pkt-line reader, the REST table, the GraphQL
reader and the authorizer (no berth or gateway changes), plus T7's server
half for `CUBED_ORIGIN` and sessions behind a disabled flag. It turns
appendix B's corpus and the Datalog fixtures into required checks before
anything enforces them.

Then, in order: (1) berth's gate on leaves with `grant_keys`,
`grant_update`, `grant_revoke` and the TTL (T1b-c, f-g, T6);
(2) cubed minting, renewal and revocation (T5); (3) the proxy's evaluation
(T1c proxy half); (4) sign-in (T7) and the documentation change for
`CUBED_ORIGIN`; (5) approvals and step-up (T1a, d, e; T7 step-up);
(6) enrollment approval (T8). SECURITY.md and docs/security.md are corrected
for protocol 4 in (1).

## Open

1. **Hosting on the internet.** Wanted by the maintainer once this is in
   place. It would also need: rate limits and lockout on `/api/auth/*`,
   the portal and update routes reviewed for public reach, TLS and
   certificate handling, logging and alerting, and a decision to change
   AGENTS.md's private-network rule. Not claimed by any test here.
2. **Keys outside cubed's Unix user.** A signer process (or the OS
   keychain) holding the root and approval keys would turn "a compromised
   cubed is total" into "a compromised cubed can request signatures it can
   be audited for". Not designed.
3. **A narrower GitHub credential per project** (fine-grained token or
   GitHub App installation), which would make cross-repository reads an
   upstream refusal.
4. **A pinned ready image for protocol-4 VM tests.** The repository pins
   none. This session used
   `mcr.microsoft.com/devcontainers/universal@sha256:019e9ea0…61d2`
   (3.9 GiB; pull and conversion took about 7 minutes; `devcontainers/base`
   lacks gh and is not "ready"). A small image published by cube would make
   T1 cheap; publishing one is the maintainer's decision.
5. **The 15 s call-path stall** (spike 4c) needs a root cause in
   `@number0/iroh` 1.1.0 or cubed's stream handling.
6. **The RP ID for the long run.** `localhost` passkeys do not carry over
   to `server1.<tailnet>.ts.net` or a public domain. Choosing the final
   name (or a registrable parent with related origins) before the first
   real registration avoids re-enrolling devices.
7. **TTL and hold times** (5 minutes, 2.5 minutes, 60 seconds) are chosen
   from the spike, not from use. They are configuration, with T1 using
   short test values.
8. **`biscuit-auth` 7** (unreleased on main) may allow adding facts to a
   built authorizer, which would lift the 2-ref limit; revisit when
   released.

## Appendix A. Authority inventory (commit 744c91299)

This appendix lists every place in cube where an action is authorized: who
can reach each entry point today, and which check decides. It was built from
six read-only surveys, and its citations were then spot-checked against the
code (section H). Where the code and a document disagree, the code wins.

Paths are relative to the repository root.

Reach codes, used in the tables below:

- **L**: anyone who can open TCP to cubed's listener and send a Host header
  from the allow-list. The allow-list is `localhost`, `127.0.0.1`, `[::1]`,
  plus `CUBED_ALLOWED_HOSTS` or `--allowed-host` (packages/server/src/index.ts:281-282,476).
  A non-browser client can set any Host it likes. An `Origin` header is
  checked only when one is sent (packages/server/src/index.ts:477). POST, PUT and PATCH need
  `Content-Type: application/json` (packages/server/src/index.ts:160-163). On this host,
  When cubed is bound to a tailnet address (as DEVELOPING.md describes), L
  is every tailnet peer that the Tailscale ACLs allow. A browser counts only when the
  page is same-origin, or for a GET that carries no Origin.
- **U**: any process running as cubed's Unix user. That includes cubed's Pi
  and codemode workers, Claude Code children, gh, git and ssh children, and
  anything else that user runs. The sockets are 0600 inside a 0700 run
  directory (packages/server/src/index.ts:120-122,882; packages/server/src/egress-policy.ts:169;
  packages/gateway/src/lib.rs:140-155; scripts/cubed-supervisor.ts:453). No socket checks peer credentials.
- **R3 / R4**: the peer that holds the private key pinned by the other side
  of a protocol-3 or protocol-4 runner connection.
- **G**: any process inside a thread's guest.

### A. Credential attachment points

| where | credential | who can trigger today | what decides |
|---|---|---|---|
| p3 gateway substitution, packages/gateway/src/http.rs:194-223 (decide, filter, substitute), packages/gateway/src/secrets.rs:44-81 | Host GitHub token (`CUBED_GITHUB_TOKEN`, otherwise `gh auth token`, cached 60 s; packages/server/src/egress-policy.ts:115-134) | G: any guest process that puts its `GH_TOKEN` placeholder in any request **header**. Bodies, paths and queries are never scanned (packages/gateway/src/secrets.rs:1-5; packages/netstack/src/placeholder.rs:76-92). That covers the agent, project hooks, the repository's `.agents/setup`, and template build VMs (packages/server/src/vm.ts:699) | `EgressPolicy.evaluate` (packages/server/src/egress-policy.ts:92-110) checks, in order: the VM exists and its thread matches (:93-94); the method is not CONNECT (:95); the placeholder belongs to this thread (:99-100); the secret is configured (:101-102); the scheme is https (:103); the host is `github.com` or `api.github.com` (:104,122). There is **no method, path, repository or project rule**. The gateway also requires TLS for any substitution (packages/gateway/src/http.rs:217-219), and the upstream must be public (packages/gateway/src/http.rs:247-251) |
| p4 credential stream: packages/berth/src/vm/egress.rs:403-405,430-498, then packages/server/src/runner-credentials.ts:82-110, then credential.sock, then packages/gateway/src/credential.rs:65-84 and packages/gateway/src/http.rs:177-233 | Same token. It is substituted in cube-gateway on cubed's host and turned back into the placeholder in the answer (packages/gateway/src/http.rs:224-233,263-281; packages/gateway/src/reverse.rs:1-2) | G on a `berth vm` machine, for any HTTPS request whose host matches the credential rule. A placeholder is **not** needed to take this route (packages/berth/src/vm/policy.rs:288-294). Also R4: any p4 session, including a host-kind runner, may open the stream (packages/server/src/runner-session.ts:355-367) | cubed's checks: a ref is present and fence ≥ 1 (packages/server/src/runner-credentials.ts:89-90); the thread exists, is not archived and has this vm; the runner's admission (configPath and configHash) matches; fence ≥ the current epoch (:41-47,52-63). There is **no runner-kind check**. The gateway's checks: `sni == host`, port 443 (packages/gateway/src/credential.rs:76-82); every placeholder is named after the header's credential (packages/gateway/src/http.rs:177-187); then the same `decide` as in p3 |
| p4 policy cubed sends, packages/server/src/egress-policy.ts:71-81, on every VM `machine_start` (packages/server/src/runner-machines.ts:83-89,142) | None. The policy only routes requests | cubed, at every boot of a VM-kind runner. The kind is taken from the live hello (packages/server/src/runner-machines.ts:117-123) | `ALLOW_PUBLIC_HTTP`, `denyHosts: []`, one https credential rule per held secret, lease 15 min. The runner enforces it (packages/berth/src/vm/policy.rs:278-304) |
| Artifact PR preview, packages/server/src/github-pulls.ts:30-36 via packages/server/src/artifact-service.ts:310 | Host gh token as a Bearer header. This path always uses `gh auth token`, never `CUBED_GITHUB_TOKEN` (packages/server/src/index.ts:340) | L: `GET /api/artifacts/:id/actions/:a` | The action must exist in a revision (packages/server/src/artifact-service.ts:300-301). If the repository is no longer in the project, a problem is recorded (:306), but the authenticated GET at :310 still runs |
| Artifact PR merge, packages/server/src/github-pulls.ts:72 via packages/server/src/artifact-service.ts:345 | Host gh token | L: `POST /api/artifacts/:id/actions/:a` | `confirm === "<repo>#<pull>"` (:330). That value is the preview's own answer (:321). There must be no problems (:336); the merge is pinned to the head SHA (:345). Actions are written by agents. A thread may name only its own project's repositories; OptChat may name any project (:93-103) |
| `gh api user/repos`, `gh auth status`, `gh api user`, `gh auth setup-git` (packages/server/src/github-auth.ts:134-138,319-325) | gh store | L: `GET /api/github/repositories`, `GET /api/github/auth` | Only that gh is connected (packages/server/src/github-auth.ts:98). Otherwise none |
| `gh auth login --web` and `gh auth logout` (packages/server/src/github-auth.ts:199,296) | Creates or removes the host's gh credential | L: `POST` and `DELETE /api/github/auth` | Login only runs when gh is not already connected (packages/server/src/github-auth.ts:195). Whoever approves the device code chooses the GitHub account the host then uses |
| Host git (packages/git): `ls-remote`, `clone --mirror`, `remote update` (packages/git/src/index.ts:340,411,427,464) | gh's git credential helper (https) and the host's SSH keys or ssh-agent (packages/git/src/index.ts:145-151) | L: `POST /api/projects`, `PUT /api/projects/:id`, `POST /api/projects/:id/check`, `POST /api/threads` (latestCommits, packages/server/src/index.ts:749). Also OptChat `spawn` (packages/server/src/optchat-threads.ts:89-90), which has **no user-turn gate** | `normalizeRepoUrl` (packages/git/src/index.ts:174-197) accepts https and ssh to any host, the scp form, `file://` and absolute paths. It refuses userinfo passwords. There is no host or owner allow-list. `GIT_ALLOW_PROTOCOL=file:https:ssh` (:151) |
| Host git for skill sources (packages/server/src/skills.ts:82,140) | gh git helper | L: `GET` and `PUT /api/settings/skills`, `GET /api/settings/skills/update`; every thread start | The URL must be `https://` without userinfo (packages/server/src/skills.ts:117-120). Any host is accepted |
| Pi model providers, in process (packages/server/src/models.ts:12-15; packages/server/src/durable-agent.ts) | Pi's `auth.json` (0600), plus provider keys in cubed's environment (repos/pi/packages/ai/src/providers/anthropic.ts:43-46) | L: anything that starts or prompts a Pi thread or OptChat; the agents' own turns | The model must be in the catalog (packages/server/src/index.ts:506-511). Pi then picks the provider's credential |
| Pi login flows (packages/server/src/model-auth.ts:42-116) | Writes or removes Pi's `auth.json` | L: `/api/providers/:id/{login,answer}`, `DELETE /api/providers/:id` | The method must be one the provider offers. Anthropic OAuth is refused (packages/server/src/model-auth.ts:17,44). The flowId and promptId are returned by GET /api/providers |
| Claude Code child, on cubed's host (packages/server/src/claude-agent.ts:45-48,299-308) | The user's Claude login (`HOME`/`CLAUDE_CONFIG_DIR` or `CLAUDE_CODE_OAUTH_TOKEN`); cubed never reads it | L: starting or prompting a `claude-code` thread; OptChat `spawn` with a `claude-code/*` model | The environment is an allow-list (:45); `ANTHROPIC_*` and the Bedrock, Vertex and Foundry switches are removed (:48). The child receives the workspace lease token as `CUBE_WORKSPACE_TOKEN` (:302) |
| `berth host` thread commands (packages/berth/src/host.rs:617-635) | The berth user's own gh, git and ssh logins, and that user's whole environment | Threads started on that runner by name (OptChat `spawn` with `runner`) | Only the R4 peer check (packages/berth/src/serve.rs:226). By design there is no policy, placeholder or proxy |
| Update supervisor (packages/server/src/update-service.ts:76) | `CUBED_UPDATE_TOKEN` | L: `GET` and `POST /api/system/update` | The supervisor token (scripts/cubed-supervisor.ts:445); `CUBED_GUI_UPDATES=1` for check and install (scripts/cubed-supervisor.ts:44,269-276); an Ed25519-signed manifest (scripts/cubed-supervisor.ts:224-229) |

### B. Routes

**Total: 104 routes.** The TCP listener has 79, workspace.sock 12, the
portal 2, egress.sock 1, gateway.sock 6, credential.sock 1 and
supervisor.sock 3. There are 2 SSE routes (B1 #37, #64) and 2 Upgrade routes
(portal #2, gateway.sock #6).

#### B1. cubed TCP listener (`CUBED_HOST:CUBED_PORT`)

The listen address defaults to 127.0.0.1:7777 (packages/server/src/index.ts:985-989) and is
bound at :1058. Nothing checks that the address is loopback or private. The
listener has **no user authentication** (packages/server/src/index.ts:470-817; `packages/server/src/auth.ts`
has no importer). Thrown errors become 409 or 502 responses
(packages/server/src/index.ts:813-817). **Who can reach every row: L.** The "what decides"
column lists only the checks beyond L.

| # | method path | line | effect | what decides |
|---|---|---|---|---|
| 1 | POST /api/optchat/media | packages/server/src/index.ts:481 | stores an image | `image/*` content type (:483); size limit |
| 2 | GET /api/optchat/media/:id | :487 | reads an image | `isMediaId` (:489) |
| 3 | GET /api/health | :513 | version, gateway and portal state | none |
| 4 | GET /api/system/update | :517 | supervisor status | none |
| 5 | POST /api/system/update `check` | :519 | the supervisor fetches the feed | managed install; sup `requireEnabled` (scripts/cubed-supervisor.ts:446,269-271) |
| 6 | POST /api/system/update `install` | :520-524 | **restarts cubed into another release** | `CUBED_GUI_UPDATES=1` (scripts/cubed-supervisor.ts:44,274-276); signed manifest |
| 7 | GET /api/state | :529 | onboarding and model-auth summary | none |
| 8 | POST /api/onboarding | :538 | writes onboarding.json | none |
| 9 | GET /api/providers | :541 | providers and the pending login view, with flow ids | none |
| 10 | DELETE /api/providers/:id | :542 | **deletes a model credential** | the provider exists |
| 11 | POST /api/providers/:id/refresh | :543 | refreshes the catalog | the provider exists |
| 12 | POST /api/providers/:id/login | :545-547 | **starts a Pi login** | supported type; no pending flow (packages/server/src/model-auth.ts:44-45) |
| 13 | DELETE /api/providers/:id/login | :549 | cancels a login | none |
| 14 | POST /api/providers/:id/answer | :551-554 | **supplies a key or code; Pi persists it** | flowId and promptId match (both readable via #9) |
| 15 | GET /api/github/auth | :558,561 | runs `gh auth status`, may run `setup-git` | none |
| 16 | POST /api/github/auth | :559 | **starts the gh device login** | gh not connected (packages/server/src/github-auth.ts:195) |
| 17 | DELETE /api/github/auth | :560 | **logs out the host's gh** | none |
| 18 | GET /api/github/repositories | :564 | lists the host account's repositories | none |
| 19 | GET /api/models | :565 | model catalog | none |
| 20 | GET /api/runners | :572 | runner node ids, addresses, health | none |
| 21 | GET /api/runners/observed | :576 | observations | none |
| 22 | POST /api/runners/:id/check | :578 | probes a runner | the runner exists |
| 23 | POST /api/runners/:id/retire | :579-597 | **retires a runner** | `confirm === nodeId` (:582; readable via #20); no active VM (:588) |
| 24 | GET /api/projects | :603 | reads projects | none |
| 25 | POST /api/projects | :604-630 | **creates a project; host git fetch with host credentials; stores hooks** | body validation; `normalizeRepoUrl` |
| 26 | PUT /api/projects/:id | :604-630 | same as #25 | the project exists |
| 27 | DELETE /api/projects/:id | :634 | deletes a project | the project exists |
| 28 | POST /api/projects/:id/check | :635 | host git fetch | the project exists |
| 29 | GET /api/projects/:id | :636 | reads a project | the project exists |
| 30 | GET /api/usage | :638 | reads usage | none |
| 31 | GET /api/settings | :644 | reads settings | none |
| 32 | PUT /api/settings/compactor | :648-660 | sets the compactor model | the model is in the catalog |
| 33 | GET /api/settings/skills/update | :663 | git fetch of the default skills | a source is configured |
| 34 | GET /api/settings/skills | :670 | resolves the sources (git fetch) | none |
| 35 | PUT /api/settings/skills | :670-680 | **sets the skills every new thread gets** | `parseSkillsConfig`; the sources resolve |
| 36 | GET /api/optchat/history | :686 | OptChat transcript; opens OptChat | none |
| 37 | GET /api/optchat/stream (SSE) | :687 | live OptChat stream | none |
| 38 | GET /api/optchat/threads | :689 | reads threads | none |
| 39 | GET /api/optchat/view | :690 | memory view | none |
| 40 | POST /api/optchat/stop | :691 | aborts the OptChat run | none |
| 41 | POST /api/optchat/prompt | :692-701 | **runs OptChat, which can spawn and tell threads** | requestId and text present |
| 42 | GET /api/optchat/model | :702 | reads the chat model | none |
| 43 | PATCH /api/optchat/model | :702-706 | sets the chat model | the model is in the catalog |
| 44 | GET /api/artifacts | :715 | lists artifacts | none |
| 45 | GET /api/artifacts/:id | :717 | reads an artifact | the artifact exists |
| 46 | GET /api/artifacts/:id/revisions/:n | :718 | reads a revision | the revision exists |
| 47 | POST /api/artifacts/:id/comments | :722-724 | adds a draft comment | exists; requestId |
| 48 | DELETE /api/artifacts/:id/comments/:cid | :725-727 | deletes a draft | the draft is unsent |
| 49 | POST /api/artifacts/:id/send | :728 | sends comments to the author as a prompt | exists; requestId |
| 50 | GET /api/artifacts/:id/actions/:a | :729-731 | **GitHub GET with the host token** | the action exists |
| 51 | POST /api/artifacts/:id/actions/:a | :732 | **merges a PR with the host token** | `confirm` = `repo#pull` (packages/server/src/artifact-service.ts:330) |
| 52 | GET /api/threads | :742 | **all threads, including `vm.vmId` and `vm.placeholders`** (`listed`, :416-417) | none |
| 53 | POST /api/threads | :743-755 | **creates a thread and boots a machine** | the project is ready; the model is available |
| 54 | GET /api/threads/:id/usage | :758 | reads usage | the thread exists |
| 55 | GET /api/threads/:id/diagnostics | :760 | machine and runner evidence | the thread exists |
| 56 | GET /api/threads/:id/steps | :763 | steps and hook log tails | the thread exists |
| 57 | GET /api/threads/:id/startup-log | :766-768 | guest call | the thread exists |
| 58 | GET /api/threads/:id/media/:ref | :771-776 | image bytes | a valid ref |
| 59 | POST /api/threads/:id/discard | :778 | **deletes a retained disk** | the thread is archived |
| 60 | DELETE /api/threads/:id | :784 | **archives the thread and releases its machine** | the thread is not archived |
| 61 | PATCH /api/threads/:id | :785 | sets the title | same |
| 62 | GET /api/threads/:id/history | :786 | reads the transcript; opens the agent | same |
| 63 | GET /api/threads/:id/services | :788-795 | guest call | same |
| 64 | GET /api/threads/:id/stream (SSE) | :796 | live transcript; opens the agent | same |
| 65 | POST /api/threads/:id/stop | :797 | aborts the agent | same |
| 66 | GET /api/threads/:id/model | :798 | reads the model; opens the agent | same |
| 67 | PATCH /api/threads/:id/model | :798-802 | sets the model | same |
| 68 | POST /api/threads/:id/prompt | :803 | **the agent runs commands in the thread's machine** (unsandboxed on `berth host`) | same |
| 69 | GET /api/threads/:id/workspace | :780 → packages/server/src/workspace-http.ts:48 | capabilities | the thread is not archived; **no token** |
| 70 | POST …/workspace/lease (no Authorization) | packages/server/src/workspace-http.ts:57-62 | **acquires the thread's only writable lease and returns its token** | `owner` = the thread's agent (packages/server/src/vm-workspace.ts:102-107; public via #52); no lease is held (packages/server/src/workspace-lease.ts:52). cubed's own agent lease has no TTL and blocks this while that agent is open |
| 71 | POST …/workspace/lease (Bearer) | :58 | heartbeat | a remote lease token; cubed-held leases are refused (:52-55) |
| 72 | DELETE …/workspace/lease | :64 | release | Bearer |
| 73 | POST …/workspace/exec | :65-70 | **runs a shell command in the machine** | Bearer = the lease token (:42-46) |
| 74 | GET …/workspace/operations/:key | :71-85 | reads output | Bearer |
| 75 | POST …/workspace/operations/:key/cancel | :86-88 | cancels | Bearer |
| 76 | GET …/workspace/file | :89-94 | reads a file in the machine | Bearer |
| 77 | PUT …/workspace/file | :95-102 | writes a file in the machine | Bearer |
| 78 | GET …/workspace/stat | :103 | stat | Bearer |
| 79 | GET /\<non-/api path\> | packages/server/src/index.ts:806-812 | static files from web/dist | GET only; the path must stay inside the directory (:809) |

#### B2. workspace.sock (`CUBED_STATE/run/workspace.sock`, packages/server/src/index.ts:819-882)

**Who can reach every row: U.** There is no Host or Origin check. Only
`/api/threads/:id/workspace…` is accepted, for threads that are not archived
(packages/server/src/index.ts:824-826).

| # | method path | line | effect | what decides |
|---|---|---|---|---|
| 1 | GET …/workspace/artifacts | packages/server/src/index.ts:830,840-848 | reads artifacts | Bearer lease (:831-834) and owner `claude-code` (:835) |
| 2 | POST …/workspace/artifacts | :849-867 | writes artifacts as that thread | same |
| 3-12 | the ten workspace routes, as B1 #69-78 | :874 → packages/server/src/workspace-http.ts:48-103 | as B1 | as B1 (a lease taken without a token works here too) |

#### B3. Portal (`CUBED_PORTAL_LISTEN:PORT`; off unless `CUBED_PORTAL_IP` is a private IPv4 address, packages/server/src/portal.ts:66-69)

| # | method path | line | effect | who can reach | what decides |
|---|---|---|---|---|---|
| 1 | ANY /\* | packages/server/src/portal.ts:162,251-286 | HTTP proxy to a service the guest registered | anyone who reaches the portal port and knows the 10-hex HMAC label (packages/server/src/portal.ts:121-131) | the Host regex, suffix and port (:197-199); the label maps to a thread whose machine is available and running (:200-205); the service is registered (:209-210); at most 64 connections (:229-231). **No user authentication and no Origin check** (:16-19) |
| 2 | Upgrade /\* | :163,290-320 | raw splice to that service | same | same |

#### B4-B6. Sockets served for and by cube-gateway

**Who can reach every row: U.**

| # | socket, route | line | effect | what decides |
|---|---|---|---|---|
| 4.1 | egress.sock POST /v1/decide | packages/server/src/egress-policy.ts:147-169 | **answers `{allow, substitute:{placeholder: real token}}`** | packages/server/src/egress-policy.ts:92-110. vmId, threadId and placeholder are not secret: GET /api/threads shows them, and so does the guest |
| 5.1 | gateway.sock GET /v1/hello | packages/gateway/src/control.rs:318 | version, peer, CA PEM | none |
| 5.2 | GET /v1/vms | :319 | all VM link statuses (no token) | none |
| 5.3 | GET /v1/vms/:id | :323 | one status | none |
| 5.4 | PUT /v1/vms/:id | :327-340 | creates the VM's LAN and dials a runner | formats (:136-146); conflict (:156-161) |
| 5.5 | DELETE /v1/vms/:id | :341-344 | detaches | none |
| 5.6 | POST /v1/vms/:id/dial?port=N (Upgrade `cube-tcp`) | :345-382 | **raw TCP to guest port 22 or any port ≥1024** | `dial_allowed` (:37-39,242-248); the VM is attached (:249-251) |
| 6.1 | credential.sock (framed header, then one HTTP/1.1 request) | packages/gateway/src/credential.rs:33-84 → packages/gateway/src/http.rs:111 | **substitutes the token and sends the request upstream from cubed's host** | `sni == host`, port 443 (packages/gateway/src/credential.rs:76-82); placeholder names (packages/gateway/src/http.rs:177-187); decide. Served only when `--credential` is given (packages/gateway/src/lib.rs:112-118); not live on this host |

#### B11. supervisor.sock (`~/.local/share/cubed/supervisor.sock`, live, 0600)

**Who can reach every row: U, and the caller must also hold the token**
(cubed receives `CUBED_UPDATE_TOKEN` in its environment, scripts/cubed-supervisor.ts:388).

| # | action | line | effect | what decides |
|---|---|---|---|---|
| 1 | status | scripts/cubed-supervisor.ts:448-449 | reads status | `request.token === token` (scripts/cubed-supervisor.ts:445) |
| 2 | check | scripts/cubed-supervisor.ts:446 | fetches the feed | plus `requireEnabled` (:269-271) |
| 3 | install | scripts/cubed-supervisor.ts:447 | **installs and restarts into a release** | plus `requireEnabled`, a signed manifest, requestId dedupe (:274-276) |

### C. Runner streams

#### C3. Protocol 3 (`cube-runner`, packages/node-transport)

cubed dials the runner with ALPN `cubeyard/node/1`, using a new endpoint per
call keyed with that runner's `control.key`. cubed's endpoint has no ALPNs,
so it accepts nothing (packages/server/src/iroh-node.ts:355). The gateway dials the runner
with ALPN `cube/l2/1`. The runner only accepts connections.

| stream / message | direction | line | can do | authenticates / decides |
|---|---|---|---|---|
| control connection | cubed→runner | packages/node-transport/src/lib.rs:19; packages/server/src/iroh-node.ts:345-397 | carries one hello and one request | cubed: `remoteId == serverPeer` (packages/server/src/iroh-node.ts:362,395), then a hello with the same binding (:309-315). Runner: `remote_id != allowed_peer` closes with UNAUTHORIZED (packages/node-transport/src/lib.rs:659-662). The hello must come first; at most 2 streams (:663-679) |
| node.hello, node.status | cubed→runner | packages/node-transport/src/lib.rs:62-68,505-512 | describes the runner | peer check plus hello |
| vm.allocate | cubed→runner | packages/node-transport/src/lib.rs:69-81; packages/node-transport/src/runner.rs:1006-1060 | creates a disk | epoch fence `journal.fence` (packages/node-transport/src/runner.rs:1034; packages/node-transport/src/journal.rs:749-765: an older epoch gets LEASE_STALE); a vmId owned by another thread gets CONFLICT (packages/node-transport/src/runner.rs:1035-1044) |
| vm.start | cubed→runner | packages/node-transport/src/lib.rs:82-95; packages/node-transport/src/runner.rs:1139-1260; packages/server/src/vm.ts:536-552 | starts QEMU; writes the seed on first start; installs the frame grant (gateway peer plus sha256 of the token) | fence (packages/node-transport/src/runner.rs:1169); the token is `randomBytes(32)` (packages/server/src/vm.ts:537); the runner keeps only its hash (packages/node-transport/src/pump.rs:47-51) |
| vm.stop, vm.release, vm.discard, vm.publish | cubed→runner | packages/node-transport/src/lib.rs:96-103,120-147 | stops, releases, deletes, publishes | peer check, hello, epoch fence |
| vm.inspect, vm.diagnose | cubed→runner | packages/node-transport/src/lib.rs:104-119 | read only | peer check plus hello |
| template.list, template.remove | cubed→runner | packages/node-transport/src/lib.rs:149-152 | lists or removes templates | **peer check only: no thread, no epoch** |
| `cube/l2/1` frames | gateway→runner | packages/node-transport/src/lib.rs:740-747 → packages/node-transport/src/pump.rs:246-275; packages/gateway/src/link.rs:212-237 | the VM's Ethernet frames | **There is no `allowed_peer` check.** The runner checks `knows_peer` (packages/node-transport/src/pump.rs:248), then a hello within 5 s with matching vm and thread, `grant.peer == peer`, and a constant-time token hash comparison (:252-270). The gateway authenticates the runner by dialing its key (packages/gateway/src/link.rs:218). Pre-auth slots: 16 pending connections, 32 frame connections |
| QEMU network, QMP, seed | runner↔QEMU | packages/node-transport/src/pump.rs:113-160; packages/node-transport/src/vm.rs:143-174 | the guest's only NIC is an inherited fd | local fds and files. `-sandbox on` is applied **only on Linux x86_64** (packages/node-transport/src/vm.rs:171-174) |
| seed (cloud-init) | cubed→runner→guest | packages/server/src/vm-seed.ts:95-164; packages/node-transport/src/seed.rs:31-42 | `agent` with NOPASSWD sudo (packages/server/src/vm-seed.ts:117), **the SSH host private key** (:123), the CA (:124), placeholders, hooks, the git helper that echoes `$GH_TOKEN` (:107-110) | the runner checks only size and non-emptiness (packages/node-transport/src/seed.rs:31-42) |
| SSH tool execution | cubed→guest | packages/server/src/guest-ssh.ts:142-175 | every tool call goes to `cube-guest` | client key `threads/<id>/vm/id_ed25519`; the host key is pinned with `StrictHostKeyChecking=yes` (packages/server/src/guest-ssh.ts:160-162); the guest's root key is limited to `restrict,command="cube-guest ssh"` (packages/server/src/vm-seed.ts:133-135); ProxyCommand is `cube-gateway dial` over gateway.sock (packages/gateway/src/dial.rs:21-27) |
| guest HTTP and HTTPS | guest→gateway | packages/gateway/src/http.rs:94-103,165-262 | egress on ports 80 and 443 only | CONNECT and Upgrade are refused (:165-170); exactly one Host, equal to the SNI (packages/netstack/src/http.rs:241-289); a decide call per request; deny on timeout or error (packages/gateway/src/decide.rs:13,59-70,113). **Hosts with no rule are allowed** (packages/server/src/egress-policy.ts:109). p3 answers are passed through without reversal (packages/gateway/src/http.rs:259-262) |
| DHCP and DNS on the gateway LAN | guest→gateway | packages/netstack/src/lan.rs:460-469,985-990 | addresses and name resolution | none |

#### C4. Protocol 4 (`berth`, ALPN `cubeyard/runner/4`)

cubed dials the runner and accepts the runner's `report` and `credential`
streams on that same connection (packages/server/src/runner-session.ts:199,332-370). berth
closes any connection unless `remote_id == allowed && alpn == ALPN`
(packages/berth/src/serve.rs:225-229). It allows at most 16 connections and a 5 s
handshake. `allowed_peer` is never rebound (packages/berth/src/main.rs:299-307). After
that check there is **no per-stream or per-owner authorization**.

| stream / message | direction | line | can do | authenticates / decides |
|---|---|---|---|---|
| Open.hello | cubed→runner | packages/server/src/runner-session.ts:209-226; packages/berth/src/vm/mod.rs:2429-2452; packages/berth/src/host.rs:300-326 | runner description, including kind and `ca_pem` | berth: protocol 4 and `expect_node == node_id` (packages/berth/src/vm/mod.rs:2440). cubed: `remoteId == serverPeer` (packages/server/src/runner-session.ts:208); protocol and nodeId (:217). threadId and environmentId are **not** checked |
| Call.machine_create, start, stop, delete, discard, template_publish | cubed→runner | runner.proto:489-503; packages/berth/src/vm/mod.rs:902-945 (`fenced`) | creates, boots (with policy and boot documents), stops and deletes machines; `berth host` only touches records | owner match (packages/berth/src/vm/mod.rs:931-935); `epoch < fence_epoch` gives stale_epoch (:936-942) |
| Call.runner_get, machine_list, template_list | cubed→runner | packages/berth/src/vm/mod.rs:2010-2029,2057 | `machine_list` returns **every owner's** machines | peer check only |
| Call.machine_get, machine_diagnose | cubed→runner | packages/berth/src/vm/mod.rs:1986-2005; packages/berth/src/vm/diagnose.rs:615-696 | read only | owner match |
| Call.template_delete | cubed→runner | packages/berth/src/vm/mod.rs:1403-1415 | removes a template | **no owner and no fence** |
| Open.watch | cubed→runner | packages/berth/src/serve.rs:58-84 | events, including `GuestInfo` as the guest reports it | peer check. `guest.ready` drives cubed's readiness (packages/server/src/runner-machines.ts:143) |
| Open.guest | cubed→runner→guest | packages/server/src/runner-session.ts:379-409; packages/berth/src/vm/mod.rs:2479-2552; packages/berth/src/host.rs:557-635 | one guest operation. On `berth host` it runs `python3 cube-guest` as the berth user with berth's **whole environment** (packages/berth/src/host.rs:624-630) | `valid_op`; `fenced`; the machine is running |
| Open.dial | cubed→runner→guest | packages/berth/src/vm/mod.rs:2553-2591 | TCP to a guest port ≥1024; host mode answers UNIMPLEMENTED (packages/berth/src/serve.rs:36-45) | `dial_port` (:2582-2591), then `fenced` |
| Open.report | runner→cubed | packages/server/src/runner-session.ts:346-354 | refusal reports, which cubed only logs | the pinned connection. The `ref` is not checked, and the loop has no frame count limit |
| Open.credential | runner→cubed→gateway | packages/server/src/runner-session.ts:355-367 → packages/server/src/runner-credentials.ts:82-110 | one HTTPS exchange sent from cubed's host with the real token | header ≤ 64 KiB; see section A row 2. **The runner's kind is not checked; the fence is the runner's own claim (only ≥ current is required, :45)** |
| DaemonFrame hello, status, ans | guest→runner | packages/berth/src/vm/channel.rs:448-539 | session start, GuestInfo, answers | session id format and the current session. A `req` or `abort` from the guest ends the socket (:544) |
| DaemonRequest guest, machine_setup, snapshot, template_publish, shutdown | runner→guest | packages/berth/src/vm/channel.rs:151-185,494-505 | operations, setup (layers, boot documents, CA cert, entropy) | the runner's own requests, issued after a fenced cubed call |
| guest egress (berth vm LAN) | guest→runner | packages/berth/src/vm/egress.rs:173-188,359-405 | HTTPS terminated with **the runner's own CA**; HTTP on 80 | in order: the lease, no CONNECT or Upgrade, Host == SNI, then `policy.decide` (packages/berth/src/vm/policy.rs:278-304). Under cubed's policy every public host is allowed directly from the runner host. The address check excludes the host's interfaces and the addresses cubed was reached at over direct paths (packages/berth/src/vm/egress.rs:509-510; packages/berth/src/vm/presence.rs:121-137). **DNS resolves any name while the lease runs** (packages/berth/src/vm/egress.rs:249-256) |

### D. Secret reads

| secret | file:line | process | where it can flow |
|---|---|---|---|
| Host GitHub token from gh | packages/server/src/github-auth.ts:168-172 (execFile inherits the full environment, :31-36) | cubed (gh child) | the decide answer on egress.sock, then cube-gateway, then request headers to github.com and api.github.com; artifact preview and merge from cubed (packages/server/src/index.ts:340) |
| `CUBED_GITHUB_TOKEN` | packages/server/src/egress-policy.ts:124-125 | cubed | gateway substitution only; it takes precedence over gh. Every child spawned with the full environment inherits it: gh (packages/server/src/github-auth.ts:32,42), git (packages/git/src/index.ts:145), ssh (packages/server/src/guest-ssh.ts:63), the local runner (packages/server/src/runner-enroll.ts:306). Not passed to Claude Code (packages/server/src/claude-agent.ts:45) or the gateway (packages/server/src/gateway.ts:243-244) |
| gh git credential helper | packages/server/src/github-auth.ts:249,325 (`setup-git`); used by packages/git/src/index.ts:340,411,427,464 | git child | whatever https host a project or skill URL names, when gh holds a credential for it |
| Host SSH keys and ssh-agent | packages/git/src/index.ts:145-151 | git→ssh | any ssh or scp-form URL |
| Pi `auth.json` (API keys, OAuth) | packages/server/src/models.ts:12-15 | cubed (Pi in process) | model-provider requests from cubed; never to guests or to Claude Code |
| Provider keys in the environment (`ANTHROPIC_API_KEY`, `ANTHROPIC_OAUTH_TOKEN`, …) | repos/pi/packages/ai/src/providers/anthropic.ts:43-46; sourced by scripts/cubed/cubed:4-10 | cubed (Pi) | as above. "Disconnect" does not remove them |
| Claude login | packages/server/src/claude-agent.ts:45,299-308 | Claude Code child | Anthropic |
| Workspace lease token | packages/server/src/claude-agent.ts:302 | cubed → Claude child | Bearer on workspace.sock |
| `CUBED_UPDATE_TOKEN` | packages/server/src/update-service.ts:39-40; minted at scripts/cubed-supervisor.ts:45 | cubed | supervisor.sock. It is also inherited by gh, git and ssh children (the full environment) |
| Gateway CA key `CUBED_STATE/gateway/ca.key` | packages/netstack/src/ca.rs:96-134 (checks group and other mode bits only, :115-117); packages/gateway/src/lib.rs:94 | cube-gateway | signs leaves for any SNI; 10 years (packages/netstack/src/ca.rs:37,104); `Constrained(0)` with no name constraints (:70) |
| Gateway Iroh key `CUBED_STATE/gateway/iroh.key` | packages/gateway/src/lib.rs:93,158-182 | cube-gateway | identity for the frame channel |
| berth CA key `.berth/ca/ca.key` | packages/berth/src/vm/ca.rs:90-148 (owner and mode checked) | berth vm | signs leaves for guest HTTPS; berth sees all guest TLS plaintext |
| cubed control key, p3 | packages/server/src/iroh-node.ts:302-307 via `readPrivate` (:165-174: O_NOFOLLOW, nlink 1, mode) | cubed | Iroh client identity |
| cubed control key, p4 | packages/server/src/runner-session.ts:195-198 (**length check only**); packages/server/src/runner-enroll.ts:52-59 (duplicate check) | cubed | Iroh client identity |
| Runner keys `runner.key` (p3, p4) | packages/node-transport/src/main.rs:48-64; packages/berth/src/main.rs:84-119 | runner | runner identity |
| Per-VM SSH keys `threads/<id>/vm/{id,host}_ed25519` | packages/server/src/vm.ts:1100-1112 | cubed | the client key reaches guest root, limited to `cube-guest ssh`. The **host private key** goes into the seed, then to the p3 runner's disk, then to the guest (packages/server/src/vm-seed.ts:123; packages/server/src/vm.ts:540-545) |
| Frame token | packages/server/src/vm.ts:537,545,550 | cubed → runner (hash only) and gateway (plaintext) | authenticates the L2 channel |
| Portal HMAC key | packages/server/src/portal.ts:121-131 | cubed | derives service labels |
| `~/.config/cubed/environment` | scripts/cubed/cubed:4-10 | launcher → cubed | becomes cubed's entire environment |
| `berth host` user's logins and environment | packages/berth/src/host.rs:624-630 | berth host | thread commands, unsandboxed |
| Placeholders `cube_ph_github_…` (not secret) | packages/server/src/egress-policy.ts:41-51; packages/server/src/registry.ts:787; packages/server/src/vm.ts:699 | cubed, runner, guest | readable through GET /api/threads (packages/server/src/index.ts:416-417,742). From the owning VM they act as bearer capabilities |

### E. Enrollment and runner selection

There is no enrollment token, invite or HTTP route. Identity rests on two
pinned Ed25519 (Iroh) keys that the operator exchanges out of band.

1. The operator makes a control key per runner with `cube-runner keygen` or
   `berth keygen` (0600, `create_new`): packages/node-transport/src/main.rs:67-77; packages/berth/src/main.rs:683-692.
2. The runner is initialized with `--allow-peer <control pubkey> --node-id …`.
   For p3: packages/node-transport/src/runner.rs:424-432. For p4: packages/berth/src/main.rs:327-363. The binding
   is immutable: "a runner is never rebound" (packages/berth/src/main.rs:299-307).
3. The operator writes a runner config (0600) on cubed's host. p3 is checked
   by `readPrivate` (packages/server/src/iroh-node.ts:165-174). p4 is checked by
   `loadSessionConfig`: O_NOFOLLOW and mode, but not nlink
   (packages/server/src/runner-session.ts:75-96).
4. The operator runs `cubed runners enroll --config …`, which is CLI only
   (packages/server/src/index.ts:957-969), and reaches `enrollRunner`
   (packages/server/src/runner-enroll.ts:32-49). `protocol === 4` dispatches to
   `enrollProtocol4` (:36-37).
5. Enrollment refuses a control key that another enrolled, non-retired
   runner uses (packages/server/src/runner-enroll.ts:51-60). An unreadable key file counts as
   "not shared".
6. The proof of identity is a QUIC connect with the remote id checked against
   `serverPeer`. For p3 it continues with a hello whose binding matches and a
   status call (packages/server/src/iroh-node.ts:309-315,395; packages/server/src/runner-enroll.ts:42-43).
   For p4 it is a hello only, and only `nodeId` is checked
   (packages/server/src/runner-session.ts:217).
7. p4 `kind` and `maxActiveVms` are taken from the runner's own hello
   (packages/server/src/runner-enroll.ts:71-74).
8. The registry rows are written in one `BEGIN IMMEDIATE`: `runner` and
   `runner_operator.enrolled_at` (packages/server/src/registry.ts:378-385). **No
   `runner_audit` row is written.** The only audit insert is `retired`
   (:604-606).
9. Who can enroll: anyone with write access to `CUBED_STATE/registry.sqlite`
   and a 0600 config on cubed's host (U).

Selection:

10. `POST /api/threads` never names a runner (packages/server/src/index.ts:750). Only
    OptChat `spawn` with `runner` does: the runner is looked up by nodeId or
    id (packages/server/src/optchat-threads.ts:83-90). The only guard is the tool
    description (packages/server/src/optchat.ts:1138-1139). `project_hooks_write`, by
    contrast, requires a user message in the turn (packages/server/src/optchat.ts:1291-1297).
11. The pool uses `runnerLoads` (packages/server/src/registry.ts:407-422), filtered by
    `pooledRunner = kind !== "host" && protocol !== 4` (:277-279). It sorts
    by fitness, then failed machines last, then the share of used slots,
    then free slots (:420-421).
12. `namedRunner` requires the runner to be enrolled, not retiring and to
    have a free slot. It does not apply `pooledRunner` (:425-433). The thread
    is marked `pinned` (:781) and never relocates (:453).
13. Protocol is chosen per thread by the runner's stored protocol
    (packages/server/src/runner-select.ts:15,51-54). The p4 VM-or-host decision at boot is
    taken from the **live hello**, not from the enrolled kind
    (packages/server/src/runner-machines.ts:117-123). A VM runner that answers HOST gets no
    policy and therefore `deny_all` (packages/berth/src/vm/mod.rs:1594-1597).
14. Epochs: cubed keeps `threads/<id>/vm/epoch` = max(current+1, now)
    (packages/server/src/vm.ts:1041-1053). p3 fences it in its journal (packages/node-transport/src/journal.rs:749-765),
    p4 per machine (packages/berth/src/vm/mod.rs:936-943).
15. Revocation: there is none. Retirement (`POST /api/runners/:id/retire`,
    L, packages/server/src/index.ts:579-597) leaves the runner, its keys and its allow-list
    untouched (docs/runner-operations.md:514-517).

### F. Docs vs code (code wins)

| # | doc claim | doc | code |
|---|---|---|---|
| 1 | gateway dial: "Only port 22 can be dialled" | packages/gateway/README.md:47-49 | 22 or ≥1024: packages/gateway/src/control.rs:11,37-39,242-248 |
| 2 | "cubed decides every request (method, host, path, thread)" | SECURITY.md:99-100; docs/security.md:7-8 | true for p3 only. On p4, berth decides locally from the policy (packages/berth/src/vm/policy.rs:278-304) that cubed sends with `ALLOW_PUBLIC_HTTP` (packages/server/src/egress-policy.ts:74); only credential-rule requests reach cubed (packages/berth/src/vm/egress.rs:403-405) |
| 3 | HTTPS is intercepted with `CUBED_STATE/gateway/ca.key`, which "never leaves that directory" | SECURITY.md:97-99 | p4 guests are intercepted by each runner's own CA `DIR/.berth/ca/ca.key` (packages/berth/src/vm/ca.rs:1-9). The runner sees the plaintext (packages/berth/src/vm/egress.rs:26-36) |
| 4 | the guest "cannot reach cubed, the runner, your LAN" | docs/security.md:8-9 | p3 excludes non-public addresses and this host's interface addresses (packages/netstack/src/addr.rs:15-17; packages/netstack/src/http.rs:131-136). p4 also excludes addresses cubed was reached at over **direct** paths (packages/berth/src/vm/presence.rs:121-137). Over a relay-only path a cubed on a public IP stays reachable, because `denyHosts` is empty (packages/server/src/egress-policy.ts:75). packages/berth/src/README.md:131-133 says so itself |
| 5 | Claude Code's environment allow-list | SECURITY.md:134-139 | the code also passes `USER`, `LOGNAME`, `SHELL`, `TERM`, `TZ` (packages/server/src/claude-agent.ts:45) |
| 6 | p4: "the token never reaches cubed's Node process" | ARCHITECTURE.md:636-637 | `evaluate` reads `source.value()` and returns it in `substitute` (packages/server/src/egress-policy.ts:105-109) |
| 7 | over relay "only `deny_hosts` keeps a guest from cubed's hosts" (implies it is used) | packages/berth/README.md:131-133 | cubed always sends `denyHosts: []` (packages/server/src/egress-policy.ts:75) |
| 8 | a host runner gets "no secrets, placeholders or proxy"; it "has no … credential path" | SECURITY.md:80-81; ARCHITECTURE.md:580 | berth host opens no credential stream (packages/berth/src/serve.rs:49-53), but cubed accepts one from any p4 admission with no kind check (packages/server/src/runner-session.ts:355-367; packages/server/src/runner-credentials.ts:52-63). Every thread has a placeholder (packages/server/src/registry.ts:787) |
| 9 | enrollment is "a hello and a status exchange" | docs/runner-operations.md:152-155 | p4 does a hello only and checks nodeId only (packages/server/src/runner-enroll.ts:65-74; packages/server/src/runner-session.ts:217) |
| 10 | the p4 guest channel "is specified but not built"; keel-layers: "No runner calls it yet" (also AGENTS.md) | ARCHITECTURE.md:588-598 | packages/berth/src/vm/channel.rs exists; berth depends on keel-layers (packages/berth/Cargo.toml:23) |
| 11 | status "as of 2026-10-05 … Next: … then berth vm" | HANDOFF.md:3,395-397 | `berth vm` exists (packages/berth/src/main.rs:32) |
| 12 | placement: "lowest share of used slots, runners with a failed machine last" | docs/runner-operations.md:219-221; ARCHITECTURE.md:491-492 | failed-machine runners come before the share comparison (packages/server/src/registry.ts:420-421) |
| 13 | "Give projects the repositories you mean it to touch" implies the token is scoped | docs/security.md:21-24 | the token is not bound to a project or repository (packages/server/src/egress-policy.ts:98-104) |

### G. Gaps (facts, most consequential first)

1. **The TCP API has no user authentication.** Every route in B1 is open to
   L (packages/server/src/index.ts:470-817). Host and Origin checks guard against DNS
   rebinding and CSRF only (:476-477). On an installation bound to a tailnet address, that is every tailnet peer. Through it anyone in L can start threads and run
   prompts, replace model credentials, run the gh login and logout, merge
   PRs and retire runners.
2. **The API gives command execution in thread machines without any agent.**
   `POST …/workspace/lease` with no token returns a lease whenever none is
   held (packages/server/src/workspace-http.ts:57-62; packages/server/src/workspace-lease.ts:52). The owner
   value it needs is public via GET /api/threads. Exec, file and stat calls
   follow (packages/server/src/workspace-http.ts:65-103).
3. **The GitHub token is unrestricted by method, path, repository or
   project.** Every thread and every template build VM gets a placeholder
   (packages/server/src/registry.ts:787; packages/server/src/vm.ts:699). `evaluate` checks only ownership,
   https and the two hosts (packages/server/src/egress-policy.ts:98-104). Repository content
   (`.agents/setup`, hooks) and agent commands can therefore make any
   GitHub call the host user's token permits.
4. **p4 egress is decided on the runner, with `ALLOW_PUBLIC_HTTP` and no
   deny hosts** (packages/server/src/egress-policy.ts:71-81; packages/berth/src/vm/policy.rs:296-303).
   Ordinary requests never reach cubed. DNS is answered for any name
   (packages/berth/src/vm/egress.rs:249-256). p3 is allow-all too: a host with no rule is
   allowed (packages/server/src/egress-policy.ts:109).
5. **OptChat `spawn` and project URLs send host git credentials to any
   URL.** `normalizeRepoUrl` accepts any https or ssh host, `file://` and
   local paths (packages/git/src/index.ts:174-197); the gh helper and ssh keys apply
   (:145-151). `spawn` has no user-turn gate, unlike hooks
   (packages/server/src/optchat.ts:1131-1139 vs :1291-1297). `spawn.runner` can pin a thread
   to an unsandboxed `berth host` runner (packages/server/src/optchat-threads.ts:83-90;
   packages/server/src/registry.ts:425-433).
6. **The same-UID sockets carry the full authority.** egress.sock returns
   the plaintext token to any U caller that presents a vmId, threadId and
   placeholder (packages/server/src/egress-policy.ts:147-169), and all three are readable
   via GET /api/threads (packages/server/src/index.ts:416-417,742). gateway.sock lets U
   attach VMs and dial any guest port 22 or ≥1024 (packages/gateway/src/control.rs:313-382).
   workspace.sock hands out leases with no token. cubed's Pi, codemode and
   Claude Code processes are U and are not sandboxed.
7. **The p4 credential route trusts the runner's own claims.** cubed does
   not check the runner's kind (packages/server/src/runner-credentials.ts:52-63). The route
   does not require a placeholder (packages/berth/src/vm/policy.rs:291-294). The gateway
   accepts any `host` where sni == host and the port is 443
   (packages/gateway/src/credential.rs:76-82). The fence is self-asserted (≥ current,
   packages/server/src/runner-credentials.ts:45). An admitted runner can therefore make
   HTTPS requests from cubed's host for its threads, and a VM runner holds
   its threads' placeholders, so it can use the token.
8. **An artifact merge is confirmed only by echoing `owner/repo#n`**
   (packages/server/src/artifact-service.ts:321,330), which anyone in L can send. The
   preview runs the authenticated GitHub GET even when the repository has
   left the project (:306,310).
9. **Model credentials can be replaced through the API**
   (`/api/providers/:id/login|answer`, DELETE; packages/server/src/index.ts:542-554). All
   agent traffic then goes to the new account.
10. **`POST /api/github/auth` lets the requester bind the host's gh to an
    account they choose** when gh is disconnected (packages/server/src/github-auth.ts:195-199).
    DELETE logs the host's gh out (packages/server/src/index.ts:560).
11. **The GitHub credentials diverge.** Egress prefers `CUBED_GITHUB_TOKEN`
    (packages/server/src/egress-policy.ts:124-125), while merges and host git use gh
    (packages/server/src/index.ts:340; packages/server/src/github-auth.ts:249). The GUI "disconnect" does not
    stop substitution while the env token is set, and the 60 s cache can
    serve a token after disconnect (packages/server/src/egress-policy.ts:117,126-131).
12. **p3 answers are not reverse-substituted.** A token echoed by GitHub
    reaches the guest (packages/gateway/src/http.rs:259-262; packages/gateway/src/reverse.rs:1-2).
13. **The runner has no per-owner authorization.** `machine_list` returns
    every owner's machines (packages/berth/src/vm/mod.rs:2012-2029). `template_delete`
    (packages/berth/src/vm/mod.rs:1403-1415) and p3 `template.remove` (packages/node-transport/src/lib.rs:149-152)
    have no owner and no fence.
14. **There is no key revocation, and retirement leaves the runner trusting
    cubed's key** (packages/node-transport/src/runner.rs:424-432; packages/berth/src/main.rs:299-307;
    docs/runner-operations.md:514-517). Retirement itself is an L route
    whose confirmation is the public nodeId (packages/server/src/index.ts:579-597).
15. **Enrollment is not audited** (packages/server/src/registry.ts:378-385,604-606). p4
    kind and capacity are self-reported (packages/server/src/runner-enroll.ts:71-74), and the
    kind is re-read from the live hello at every boot
    (packages/server/src/runner-machines.ts:117-123). The p4 hello binds only nodeId
    (packages/server/src/runner-session.ts:217).
16. **The p4 control key is read without mode, nlink or symlink checks**
    (packages/server/src/runner-session.ts:195-198; packages/server/src/runner-enroll.ts:53), unlike p3
    (packages/server/src/iroh-node.ts:165-174).
17. **cubed's full environment reaches its gh, git, ssh and runner
    children**, including `CUBED_GITHUB_TOKEN`, `CUBED_UPDATE_TOKEN` and
    provider keys (packages/server/src/github-auth.ts:32,42; packages/git/src/index.ts:145;
    packages/server/src/guest-ssh.ts:63; packages/server/src/runner-enroll.ts:306).
18. **Env-sourced provider keys survive "disconnect"**, and
    `ANTHROPIC_OAUTH_TOKEN` from the environment is not covered by the
    OAuth block (repos/pi/packages/ai/src/providers/anthropic.ts:43-46;
    packages/server/src/model-auth.ts:17).
19. **The guest's SSH host private key passes through the p3 runner**
    (packages/server/src/vm-seed.ts:123; packages/node-transport/src/runner.rs:1214). A runner can impersonate the
    guest that cubed pins.
20. **The CAs have no name constraints and are trusted for every name**
    (packages/netstack/src/ca.rs:70; packages/berth/src/vm/ca.rs:63). The gateway CA load checks mode bits
    but not owner or symlinks (packages/netstack/src/ca.rs:115-117). berth sees all p4 guest
    TLS in plaintext.
21. **QEMU `-sandbox` is applied only on Linux x86_64** (packages/node-transport/src/vm.rs:171-174).
22. **The portal has no user authentication.** A 10-hex HMAC label is the
    only secret (packages/server/src/portal.ts:16-19,121-131).
23. **The host runner passes its whole environment to commands**
    (packages/berth/src/host.rs:624-630), not only gh and git.
24. **Guest and runner claims flow into cubed unchecked.** `GuestInfo.ready`
    drives readiness (packages/server/src/runner-machines.ts:143). Report frames are logged
    without a ref check (packages/server/src/runner-session.ts:346-354).
25. **Pre-auth slots are a DoS surface, not a bypass.** p3 `cube/l2/1`
    accepts any peer up to `knows_peer`, with 16 pending and 32 frame
    connections (packages/node-transport/src/lib.rs:740-747; packages/node-transport/src/pump.rs:248). berth allows 16
    connections with a 5 s handshake (packages/berth/src/serve.rs:201-229).
26. **Project hooks are stored in clear** in registry.sqlite and are
    readable by every machine of the project (packages/server/src/project-hooks.ts:14).
27. **Dead code still has credential reach:** `readGithub`
    (packages/server/src/github-read.ts), packages/git `push`, `createPr` and `syncBase`
    (packages/git/src/index.ts:698,760,822), and `packages/server/src/auth.ts`. None has a production
    caller.

### H. Verification note

- **Inputs:** B-routes.md, C3-protocol3.md, C4-protocol4.md, AD-secrets.md,
  E-enroll-docs.md and docs-vs-code-security.md.
- **What was checked:** 152 file:line citations were opened with `sed -n`
  or `grep -n` against commit 744c91299. They cover every row of F, every
  row of G, all 42 route dispatch lines in packages/server/src/index.ts, and samples from
  A, C, D and E. Live listeners and the supervisor socket mode were read on the
  maintainer's installation.
- **Fixed: 21 citations** (about 30 stale line references). All were in the C3 part, which cited a
  pre-refactor layout of cube-gateway: packages/gateway/src/http.rs is 355 lines, packages/gateway/src/lib.rs
  197, packages/gateway/src/main.rs 186, packages/gateway/src/decide.rs 179 and packages/gateway/src/dial.rs 91.
  - packages/gateway/src/http.rs: CONNECT and Upgrade → :165-170; port dispatch → :94-103;
    placeholder scan → :176; substitution → :212-223; Proxy-Authorization
    → :236; non-public upstream → :247-251; p3 answer passed through →
    :259-262; credential mode → :177-192, :224-233, :263-281.
  - packages/gateway/src/decide.rs: timeout → :13; answer cap → :15; deny on error or
    timeout → :59-70; non-200 → :113.
  - packages/gateway/src/lib.rs: state dir → :92; iroh.key → :93,158-182; CA → :94;
    credential socket → :112-118.
  - packages/gateway/src/main.rs: system roots → :62-68; lifeline → :132-136.
  - packages/gateway/src/dial.rs: → :21-27.
  - No fixes were needed outside the C3 gateway citations; the other
    parts' line numbers held up.
- **Added on verification:** GET /api/threads returns `vm.placeholders`
  and `vmId` (packages/server/src/index.ts:416-417,742). This joins the same-UID egress.sock
  gap and the p4 credential gap.
- **Removed on verification (5):**
  - "runner updates contradict" (docs-vs-code #7): SECURITY.md:59 and
    docs/security.md:31-33 agree that the runner has its own signed updater.
  - E D8, "registry implies audited enrollment": ARCHITECTURE.md:411-413
    says only "retirement audit", which is accurate.
  - E D9, the runbook key-path layout: two layouts exist, and neither doc
    contradicts the code.
  - E's scope note citing docs/security.md:180-192: that file has 37 lines.
  - C3's "gateway refuses MTU != 1500 at link.rs:227-229": not re-verified,
    so left out.
- **Not re-verified, kept as cited by the parts:** Rust line numbers inside
  packages/netstack/src/lan.rs, packages/berth/src/vm/diagnose.rs and runner.proto; Pi's auth-storage mode;
  CI release-key handling.

## Appendix B. Traffic corpus

**How it was recorded.** A disposable cubed in a test process
(`spikes/2026-10-15-authorization/capture/authz-capture-p4.ts`, derived
from the C-a harness `runner-vm-cubed-test.ts`) with cubed's real code: the
project, the thread started by name on a real `berth vm`, cubed's
`policyFor`, the credential stream, cube-gateway's credential proxy and the
host's GitHub token as the `github` secret. berth was built with
`spikes/2026-10-15-authorization/capture/berth-gate-record.patch`, which
writes each request at the gate, as the guest sent it and before the
policy, as one JSON line. The keel machine (kernel and base built from
this commit; QEMU 11.1.2 under KVM) ran
`mcr.microsoft.com/devcontainers/universal@sha256:019e9ea0eebbab70fb44c68874f975dbeea6b56faf6ad7f97065fd6bce8b61d2`
(gh 2.102.0, git 2.56.0, npm 11.19.0). The thread worked in a private,
disposable repository created for this (`dizk/cube-authz-capture`; three
pull requests opened and merged there). No other thread or live state was
touched. Assertions in the harness: the host's token is not in the
recording and not in the guest (`grep` over `/home /etc /root /tmp /workspace`).

As a control, the same scenarios ran on protocol 3 (cube-runner, a
cube-gateway built with `gateway-record.patch`, Debian 13 genericcloud with
Debian's gh 2.46.0). Apart from apt and two requests newer gh and npm add,
both corpora have the same requests by scenario, method, host and action
kind: what clients send does not depend on the protocol. The protocol-3
recording is not kept as a fixture.

**Files** (`packages/runner-protocol/fixtures/authz/corpus/`):

- `p4-berth-gate.jsonl`: 87 requests, one per line: scenario, method, host,
  target, headers, base64 body, and the actions the gate derives
  (`spikes/…/capture/facts.ts`). The run's placeholder is replaced by
  `cube_ph_github_0000000000000000000000` (also inside `Authorization: Basic`);
  cookies are dropped; times are relative.
- `p4-berth-gate.scenarios.json`: the commands per scenario and their output.
- `p4-berth-gate.expected.json`: the reference profile (authority block and
  authorizer, test-only keys) and the expected verdict per request,
  produced by `spikes/…/capture/replay.ts` with biscuit-wasm.

**What can be derived, and what cannot.**

| fact | derived from | in the corpus |
|---|---|---|
| op | URL path and method (git smart HTTP endpoints, GitHub OpenAPI operation id) | every request |
| repo | path (`/{owner}/{repo}[.git]/…`, `/repos/{owner}/{repo}/…`) | all git and REST repository requests |
| ref, old and new object id | receive-pack pkt-line command list (before the pack) | 9 pushes, 11 ref updates |
| ref for a REST write | JSON body (`ref`, `branch`, `base`) or path (`git/refs/{ref}`) | `contents` PUT, `git/refs` POST and PATCH |
| sha for a REST write | JSON body `sha` | `git/refs` POST and PATCH |
| host, method | request line and SNI = Host | every request |
| GraphQL operation | parsed document: operation type and top-level fields, fragments resolved | 13 GraphQL requests |
| GraphQL target repository | **not derivable at the gate**: node ids (`repositoryId: "R_…"`, `pullRequestId`) | `createPullRequest`, `createIssue`, `mergePullRequest` |
| what a push changes | **not derivable** without the object graph: files, authorship, whether it is a force push | all pushes |
| sha of a `contents` PUT | **not derivable**: GitHub creates the commit | 1 |

Decisions for what cannot be derived: GraphQL queries get one coarse grant;
GraphQL mutations are denied except an allow-list whose node ids cubed's
proxy resolves (`createPullRequest` in the reference profile); merges are
denied to agents; a REST write that moves a ref without a sha is allowed
only under the thread's prefix, never by approval; a push's content is not
judged. Observed details the design relies on: every push and every fetch
first sends `info/refs` without credentials, then again with them (the
answers were not recorded); fetches use protocol v2 and gzip their larger `fetch`
requests (the body is not needed to decide a fetch); pushes use protocol
v0 and were never compressed; gh sends GraphQL documents with fragments
and an `operationName`-less form; `gh pr merge` uses `mergePullRequest`
after two `__type` introspection queries; a REST `PATCH git/refs/heads/main`
to a PR's head marks the PR merged (seen on the first recording).

**Replay with expected verdicts** (reference profile: the repository,
`refs/heads/cube/<t>/` for pushes and deletes, `main` behind approval,
GET/HEAD to Ubuntu, Debian, npm and GitHub hosts, GitHub reads,
`pulls/create`, GraphQL queries, the `createPullRequest` mutation; at most 2
ref updates per push). The gate's half only; the proxy's node-id check is T5.

| scenario | n | request | actions | expected |
|---|---|---|---|---|
| machine-checkout | 2 | `GET github.com/{o}/{r}/info/refs` | git_discover | allow |
| machine-checkout | 2 | `POST github.com/{o}/{r}/git-upload-pack` | git_fetch | allow |
| setup-apt | 5 | `GET security.ubuntu.com/…` | http | allow |
| setup-apt | 14 | `GET archive.ubuntu.com/…` | http | allow |
| setup-apt | 3 | `GET packages.microsoft.com/…` | http | deny (not granted) |
| git-clone | 2 | `GET github.com/{o}/{r}/info/refs` | git_discover | allow |
| git-clone | 2 | `POST github.com/{o}/{r}/git-upload-pack` | git_fetch | allow |
| git-clone-v0 | 2 | `GET github.com/{o}/{r}/info/refs` | git_discover | allow |
| git-clone-v0 | 1 | `POST github.com/{o}/{r}/git-upload-pack` | git_fetch | allow |
| git-push-branch | 2 | `GET github.com/{o}/{r}/info/refs` | git_discover | allow |
| git-push-branch | 1 | `POST github.com/{o}/{r}/git-receive-pack` | git_push(create refs/heads/cube/<t>/work) | allow |
| git-push-main | 2 | `GET github.com/{o}/{r}/info/refs` | git_discover | allow |
| git-push-main | 1 | `POST github.com/{o}/{r}/git-receive-pack` | git_push(update refs/heads/main) | deny (needs approval) |
| git-push-multi | 2 | `GET github.com/{o}/{r}/info/refs` | git_discover | allow |
| git-push-multi | 1 | `POST github.com/{o}/{r}/git-receive-pack` | git_push(create refs/heads/cube/<t>/a);git_push(create refs/heads/cube/<t>/b) | allow |
| git-push-force | 2 | `GET github.com/{o}/{r}/info/refs` | git_discover | allow |
| git-push-force | 1 | `POST github.com/{o}/{r}/git-receive-pack` | git_push(update refs/heads/cube/<t>/work) | allow |
| git-push-delete | 2 | `GET github.com/{o}/{r}/info/refs` | git_discover | allow |
| git-push-delete | 1 | `POST github.com/{o}/{r}/git-receive-pack` | git_push(delete refs/heads/cube/<t>/b) | allow |
| git-push-tag | 2 | `GET github.com/{o}/{r}/info/refs` | git_discover | allow |
| git-push-tag | 1 | `POST github.com/{o}/{r}/git-receive-pack` | git_push(create refs/tags/capture-<t>) | deny (not granted) |
| git-push-atomic-options | 2 | `GET github.com/{o}/{r}/info/refs` | git_discover | allow |
| git-push-atomic-options | 1 | `POST github.com/{o}/{r}/git-receive-pack` | git_push(create refs/heads/cube/<t>/c);git_push(update refs/heads/cube/<t>/work) | allow |
| git-fetch | 2 | `GET github.com/{o}/{r}/info/refs` | git_discover | allow |
| git-fetch | 1 | `POST github.com/{o}/{r}/git-upload-pack` | git_fetch | allow |
| git-ls-remote | 2 | `GET github.com/{o}/{r}/info/refs` | git_discover | allow |
| git-ls-remote | 1 | `POST github.com/{o}/{r}/git-upload-pack` | git_fetch | allow |
| gh-pr-create | 2 | `POST api.github.com/graphql` | github_graphql(query repository) | allow |
| gh-pr-create | 1 | `POST api.github.com/graphql` | github_graphql(mutation createPullRequest) | allow |
| gh-pr-list-view | 3 | `POST api.github.com/graphql` | github_graphql(query repository) | allow |
| gh-api-rest-read | 1 | `GET api.github.com/repos/{o}/{r}` | github_rest(repos/get) | allow |
| gh-api-rest-read | 1 | `GET api.github.com/repos/{o}/{r}/pulls` | github_rest(pulls/list) | allow |
| gh-api-rest-read | 1 | `GET api.github.com/user` | github_rest(users/get-authenticated) | allow |
| gh-api-rest-write-issue | 1 | `POST api.github.com/repos/{o}/{r}/issues` | github_rest(issues/create) | deny (not granted) |
| gh-api-rest-write-contents | 1 | `PUT api.github.com/repos/{o}/{r}/contents/rest-t-7e31bb2a.txt` | github_rest(repos/create-or-update-file-contents) | allow |
| gh-api-graphql-query | 1 | `POST api.github.com/graphql` | github_graphql(query viewer) | allow |
| gh-api-graphql-mutation | 1 | `POST api.github.com/graphql` | github_graphql(query repository) | allow |
| gh-api-graphql-mutation | 1 | `POST api.github.com/graphql` | github_graphql(mutation createIssue) | deny (not granted) |
| gh-pr-merge | 2 | `POST api.github.com/graphql` | github_graphql(query __type) | allow |
| gh-pr-merge | 1 | `POST api.github.com/graphql` | github_graphql(query repository) | allow |
| gh-pr-merge | 1 | `POST api.github.com/graphql` | github_graphql(mutation mergePullRequest) | deny (not granted) |
| gh-api-rest-write-ref | 1 | `POST api.github.com/repos/{o}/{r}/git/refs` | github_rest(git/create-ref) | allow |
| gh-api-rest-write-ref | 1 | `PATCH api.github.com/repos/{o}/{r}/git/refs/heads/main` | github_rest(git/update-ref) | deny (needs approval) |
| npm-install | 3 | `GET registry.npmjs.org/…` | http | allow |
| npm-install-audit | 2 | `GET registry.npmjs.org/…` | http | allow |
| npm-install-audit | 1 | `POST registry.npmjs.org/-/npm/v1/security/advisories/bulk` | http | deny (not granted) |
| curl-download | 1 | `GET raw.githubusercontent.com/{o}/{r}/main/README.md` | http | allow |

## Appendix C. Spike results against thresholds

Thresholds, as written before any measurement (2026-10-15 19:03 CEST):

> a. Gate authorization (biscuit-auth, Rust, release build, realistic policy):
> p99 < 1 ms per request without cache; also report with a per-flow cache.
> Also token parse+signature verify per new flow: p99 < 1 ms.
> b. biscuit-wasm in cubed (Node 26): mint, attenuate, third-party block,
> verify all work; every shared fixture gives the same verdict in Rust and TS
> (100 %, no exceptions). Informational: TS verify p99.
> c. Revocation propagation cubed -> runner over protocol 4, connected
> runner, loopback/LAN: p99 < 1 s from cubed's revoke to the gate refusing
> the next request; 100 % delivered. Disconnected runner: refusal no later
> than token expiry (TTL) + lease, by construction; measured on one forced
> disconnect.
> d. Passkeys: pass = registration + assertion with UV succeed via
> Chromium's virtual authenticator (CDP WebAuthn) on the origin.

Machine: Intel i7-8700 (6 cores, 12 threads), 62 GiB, Linux 6.8, the
maintainer's shared host; its load average (6-20) is recorded with each run
and no run was discarded. Code: `spikes/2026-10-15-authorization/`
(`biscuit-bench`, `biscuit-ts`, `revocation`, `passkeys`, `capture`), each
with a README; none of it is product code.

### 4a. biscuit-auth 6.0.0 in the gate (Rust 1.91, release)

Token: authority with 29 grant and identity facts, one attenuation block,
one third-party approval block (2554 bytes, 4 signatures). hdrhistogram,
100 000 iterations per row (50-ref rows: 2000 pushes). "fail" = a valid
request denied by biscuit-auth's default 1 ms run limit.

| measurement | load 6-7, p50 / p99 | load 9-12, p50 / p99 | load 11-20, p50 / p99 | threshold | verdict |
|---|---|---|---|---|---|
| token parse + signature verify | 224 / 449 µs | 353 / 586 µs | 415 / 612 µs | p99 < 1 ms | pass |
| one action, uncached: push under prefix | 142 / 292 µs | 210 / 386 µs (20 fail) | 196 / 361 µs | p99 < 1 ms | pass |
| one action, uncached: push main with approval | 151 / 318 µs | 162 / 392 µs (1 fail) | 189 / 378 µs | p99 < 1 ms | pass |
| one action, uncached: push main denied | 222 / 406 µs | 290 / 452 µs (7 fail) | 338 / 5460 µs (1395 fail) | p99 < 1 ms | **fail under load** |
| one action, uncached: http GET | 135 / 378 µs | 195 / 1689 µs (120 fail) | 267 / 1341 µs (100 fail) | p99 < 1 ms | **fail under load** |
| one action, cached builder: push under prefix | 120 / 235 µs | 178 / 319 µs | 214 / 303 µs | p99 < 1 ms | pass |
| one push with 50 ref updates, uncached | 7.9 / 14.8 ms | 12.1 / 18.4 ms | 14.6 / 25.2 ms | p99 < 1 ms | **fail** |
| one push with 50 ref updates, cached builder | 6.8 / 13.0 ms | 11.8 / 16.1 ms | 6.9 / 15.0 ms | p99 < 1 ms | **fail** |

Where one authorization spends its time (means): parsing policies and
ambient facts 50 µs, `build(token)` 193 µs, `authorize` 53 µs. biscuit-auth 6
cannot add facts to a built authorizer, so `build(token)` (70-80 %) is paid
per action and a per-flow cache saves about 15 %. Design consequences: at
most 2 ref updates per push; plain HTTP on `(host, method)` with a verdict
cache; explicit run limits; no per-flow authorizer cache (plan, "What the
evidence says").

### 4b. biscuit-wasm 0.6.0 in Node 26.8.1

| check | result |
|---|---|
| mint with the root key and `root_key_id` | pass (the id is readable only through `fromBytesWithProvider`'s callback) |
| attenuate (`appendBlock`) | pass |
| third-party block (`getThirdPartyRequest().createBlock`, `appendThirdPartyBlock`) | pass within one process; `ThirdPartyBlock.fromBytes` returns a request, so a block received as bytes cannot be appended in JS |
| verify and authorize | pass |
| revocation ids | pass (`getRevocationIdentifiers`) |
| same verdict in Rust and TS, every fixture | **pass: 42 / 42** in Rust, in TS, Rust on TS-minted tokens and TS on Rust-minted tokens (37 from the spike, 5 added for this plan's leaf TTL, deny and plain-HTTP shapes) |
| cold start | the first authorization in a fresh process took 30-55 ms and exceeded biscuit-wasm's 20 ms default (a deny); `authorizeWithLimits` sets it |
| TS timing (informational) | verify p99 1.54 ms; verify + authorize p50 1.29 / p99 1.78 ms |

Library findings: `new KeyPair()` and the keys of appended blocks are
seeded from 64 bits; there is no authorizer clone; a throwing key provider
panics the module; the bundler build loads in Node 26 with an
ExperimentalWarning.

### 4c. Revocation over protocol 4

Real `berth host` (release) and cubed's real `RunnerSession` over Iroh; a
spike-only `grant_revoke` call and a runner-wide revoked set checked before
a real `Policy::decide` (`spikes/…/revocation/spike.patch`).

| path | samples | send → refusal p50 | p99 | max | delivered | threshold | verdict |
|---|---|---|---|---|---|---|---|
| loopback | 6 × 2000 | 0.21-0.23 ms | 0.42-0.88 ms | 3.6 ms | 12 000 / 12 000 | p99 < 1 s, 100 % | pass |
| relay only (`euc1-1.relay.n0.iroh.link`) | 300 + 1000 | 24-28 ms | 27.5-56 ms | 70 ms | 1300 / 1300 | informational | pass |

In-process cost: inserting an id 170 ns; a check (set plus policy) 160-200 ns;
rebuilding a policy that contains 100 000 ids 7.5 ms (so the set stays
apart). Caveat: about one call in 65 000 on the existing call path stalls in
`openBi()` for the whole 15 s timeout (6 in about 400 000 calls); not seen on a
revoke, but the same path. Disconnect: a clean close is seen in 4 ms
(30 ms via relay); a killed cubed after 33 s (QUIC idle timeout), so today's
bound is about 33 s + 900 s lease. With the plan's 5-minute leaf TTL, the
bound is the TTL.

### 4d. Passkeys on the access paths

Chromium 153 (Playwright 1.63, new headless), CDP virtual authenticator
(ctap2, internal, resident key, UV), a relying party using
`@simplewebauthn/server` 13 that checks a configured origin; loopback only,
names mapped with `--host-resolver-rules`, certificates from a local CA
trusted with `--ignore-certificate-errors-spki-list`.

| origin | secure context | create / get | server rejects UV = 0 | Secure cookie | verdict |
|---|---|---|---|---|---|
| `http://localhost` | yes | ok / ok | yes | yes | pass |
| `http://127.0.0.1` (documented default URL) | yes | `SecurityError: This is an invalid domain.` | - | yes | fail |
| `http://100.x.y.z:7777` (documented tailnet recipe) | no | `navigator.credentials` undefined | - | no | fail |
| `http://<host>.<tailnet>.ts.net` | no | same | - | no | fail |
| `https://<host>.<tailnet>.ts.net`, trusted certificate | yes | ok / ok | yes | yes | pass |
| same, certificate error clicked through | yes | `NotAllowedError: WebAuthn is not supported on sites with TLS certificate errors.` | - | yes | fail |
| Caddy TLS + basic_auth, cubed checks the configured origin, RP ID = public name | yes | ok / ok | yes | yes | pass |
| same proxy, origin derived from the request's Host | yes | origin mismatch (`https` vs `http`) | - | - | fail |
| same proxy, RP ID `localhost` | yes | `SecurityError` (RP ID not a suffix) | - | yes | fail |
| proxy under a path (`https://example.test/cube/`) | yes | ok / ok | yes | yes (Path=/cube/) | pass |
| `https://cube.example.com`, RP ID `cube.example.com` or `example.com` | yes | ok / ok | yes | yes | pass |
| same, RP ID `com` | yes | `SecurityError` | - | yes | fail |

With `userVerification: "required"` and an authenticator that does not
verify, Chromium itself refuses; with `"discouraged"` the server's UV check
is what refuses, on every passing origin. A CDP virtual authenticator
switches off Chromium's certificate-error refusal; the refusal was
confirmed by calling `create()` before enabling it.

## Appendix D. Primary specifications: what the design rests on

Sources and revisions read: eclipse-biscuit/biscuit `SPECIFICATIONS.md` at
b3d3fe2d; biscuit-rust at 93832a82 (main is the unreleased 7.0.0; crates.io
6.0.0); biscuit-wasm at 80cceedb (0.6.0); W3C WebAuthn Level 3 (REC
2026-08-25) and Secure Contexts; Chromium at 9856ef6e; git's
`gitprotocol-{pack,http,common,v2,capabilities}` and `remote-curl.c` at
6de20f60; github/rest-api-description at a7fb3ea2; GitHub's public GraphQL
schema (fetched 2026-10-15); agentbaseline.org white paper (v1.0-draft,
2026-07-30) and "The Secure Software Factory" (2026-10-13).

**Biscuit**

- Checks in a block see facts from the authority block, the block itself
  and the authorizer, unless a `trusting` annotation adds blocks signed by
  a given key (§Scope annotations; biscuit-rust `datalog/origin.rs:117-130`).
  A derived fact's origin is the union of its inputs' origins, which is
  why the draft approval shape failed (appendix C, 4b).
- Third-party blocks sign the previous block's signature together with
  their content (§Third-party blocks), so they cannot be moved to another
  token; they can be replayed on the same one.
- `check all` fails when nothing matches (`datalog/mod.rs:215-248`); allow
  policies cannot rescue a failing check. Both released implementations
  speak Datalog 3.3 (`token/mod.rs:37-45`); `reject if`, used for a user's
  deny, works in both (fixture `deny-reject-block-denied`).
- Revocation ids are the blocks' signatures (`token/mod.rs:205-218`);
  biscuit-rust does not add the spec's `revocation_id` facts, so the
  verifier compares them in code.
- `root_key_id` is a hint for the verifier's key provider
  (`RootKeyProvider::choose`, `token/mod.rs:714-718`); rotation is a new key
  with a new id.
- Default run limits: 1000 facts, 100 iterations, 1 ms (`datalog/mod.rs:740-759`);
  biscuit-wasm's `authorize()` uses 20 ms and `authorizeWithLimits` sets its
  own (`src/authorizer.rs:15-36`).
- P-256 block signatures cover the raw block payload (`crypto/p256.rs:43-50,229-244`);
  a WebAuthn assertion signs `authenticatorData ‖ SHA-256(clientDataJSON)`,
  so a passkey cannot sign a block.
- biscuit-wasm 0.6.0: `ThirdPartyBlock.fromBytes` returns a request
  (`src/lib.rs:267-286`); no `rootKeyId()` getter.

**WebAuthn and secure contexts**

- The RP ID must be a valid domain equal to or a registrable suffix of the
  origin's effective domain, not a public suffix; an IP address is refused
  with `SecurityError` (§5.1.3 step 7, §5.1.4.1 step 6). `ts.net` is on the
  Public Suffix List.
- `http://localhost` is a secure context (Secure Contexts §3.1); other plain
  HTTP origins are not, and `navigator.credentials` is then absent.
- Chromium refuses WebAuthn on a page with a certificate error
  (`authentication_credentials_container.cc:1454-1457`).
- The RP verifies UP and UV itself (§7.1, §7.2 steps 16-17); discoverable
  credentials with `residentKey: "required"` and an empty
  `allowCredentials` (§5.2.2).
- Challenges "MUST be randomly generated by Relying Parties" with enough
  entropy (§13.4.3); hence random bytes followed by the action digest.
  Transaction display extensions were dropped after Level 1, so the
  authenticator shows the user nothing about the action.

**Git**

- Smart HTTP: `GET info/refs?service=…`, `POST git-upload-pack`,
  `POST git-receive-pack` (gitprotocol-http, lines 201-213, 320-330,
  485-503). A receive-pack request is `*shallow (command-list | push-cert)`,
  then push options if negotiated, then the pack; commands are
  `old-id SP new-id SP refname`, zero ids meaning create and delete
  (gitprotocol-pack lines 523-607); ids are 40 or 64 hex digits.
- Pushes are always protocol v0: git falls back for anything but
  upload-pack (`remote-curl.c:495-501`, `connect.c:1452-1460`). git gzips
  upload-pack requests, not receive-pack ones (`remote-curl.c:1247`).
- Without `atomic`, a server may apply some ref updates and reject others
  (gitprotocol-pack lines 699-704). The protocol has no force flag.

**GitHub**

- 1242 REST operations (GET 651, POST 194, DELETE 189, PUT 134, PATCH 74),
  531 under `/repos/{owner}/{repo}`. The ref a write moves can be in the
  path, in the JSON body (`branch`, `ref`, `base`, `head`,
  `target_commitish`), implied by a number, or absent (the default branch).
- 278 GraphQL mutations; `operationName` is optional and client-chosen; one
  document may carry several aliased operations, fragments and directives;
  ref-writing mutations name their targets by node id.

**Agent Baseline** (a framework mapped onto, not a specification)

| control | in this plan |
|---|---|
| AUT-02 purpose- and task-bound authority | authority block per thread machine |
| AUT-03 delegation attenuation | attenuation blocks; OptChat `spawn` only attenuates |
| AUT-04 just-in-time credentials outside the agent | placeholders in the guest, the token at cubed's proxy, 5-minute leaves |
| AUT-05 independent approval of the specific action | approval blocks bound to ref and object id |
| AUT-07 step-up verification | fresh UV assertion over the action digest |
| AUT-09 proof-of-possession binding | `runner(<node id>)` checked against the gate's own id and the proxy's peer |
| RES-01 immediate revocation | `grant_revoke`, p99 under 1 ms connected |
| AUT-06 fail-closed | unknown actions, parse failures and run-limit timeouts deny |
