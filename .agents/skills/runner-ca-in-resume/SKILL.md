---
name: runner-ca-in-resume
description: Make a cube thread machine's tools trust the runner's CA from a project's `.agents/resume` (Java keystores, bundled JDKs, tools with their own CA list) without putting that CA into a template. Use when writing or debugging `.agents/setup` or `.agents/resume` for HTTPS trust, a PKIX or "unable to find valid certification path" error, or a template build that fails its seal on a runner CA or `/etc/ssl/certs/java/cacerts`.
---

# The runner's CA in `.agents/resume`

Provenance: written from cube's source at v0.3.33 (`278686d0`) and from
commands run in a Debian 13 thread machine on 2026-10-22. It is not based on
Amp's guidance, because no copy of that was found in this repository or the
project's artifacts.

## What cube does today

On a `berth vm` runner, HTTPS (port 443) out of a thread machine is
terminated by the runner and re-signed with the **runner's CA**. There is one
CA per runner, valid for 10 years (`packages/berth/src/vm/ca.rs`). On every
boot, keel's `machine_setup` (`packages/keel/agent/src/generated.rs`) writes
it to:

| where | what |
| --- | --- |
| `/etc/cube/ca.pem` | the CA, bind-mounted read only: **the source to read**. Absent when the runner sends no CA (`berth host`, which runs no proxy) |
| `/etc/ssl/certs/ca-certificates.crt` (or `/etc/pki/tls/certs/ca-bundle.crt`, `/etc/ssl/cert.pem`) | the CA appended between `# cube:` marker lines |
| `/usr/local/share/ca-certificates/cube-runner.crt` | only if that directory exists, so `update-ca-certificates` keeps the CA |
| `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE`, `CURL_CA_BUNDLE` | set to the bundle for every command |

keel does **not** run `update-ca-certificates`, and it never touches derived
stores. A Java keystore made by `ca-certificates-java` while `.agents/setup`
runs does not contain the runner's CA. This was checked on Debian 13: the
store had 150 public roots, `java` failed with PKIX errors, and `curl`
succeeded.

When the hooks run (`packages/server/src/conversation.ts`, `vm.ts`):

```text
template build:   checkout ─▶ pre-setup ─▶ .agents/setup ─▶ seal + publish   (no resume)
fresh thread:     checkout ─▶ pre-setup ─▶ .agents/setup ─▶ pre-resume ─▶ .agents/resume
template thread:  template disk + checkout ─────────────▶ pre-resume ─▶ .agents/resume
every later boot:                                         pre-resume ─▶ .agents/resume
```

The template seal (`packages/keel/agent/src/template.rs`, `seal_check`) is a
backstop, not a guarantee. When a runner CA was installed, it refuses a layer
if:

- a file holds a **plain** copy of that CA: its DER, or its first 48 bytes as
  base64;
- `/etc/ssl/certs/java/cacerts` is a file the build wrote, whatever it holds.

It cannot see a copy that is compressed (inside a jar or a `.gz`) or that a
keystore stores encrypted. Such a copy would reach the template.

## Rules

1. **Add trust in `.agents/resume`, never in `.agents/setup`.** Resume runs on
   every boot of every thread machine, after setup, and never in a template
   build. What setup imports can reach the template, whether or not the seal
   sees it.
2. **Read the CA from `/etc/cube/ca.pem` on every run.** Never copy it into
   the repository, a hook or a seed: it is not a secret, but it belongs to
   one runner.
3. **When it is absent, skip only the trust work.** No `/etc/cube/ca.pem`
   means the runner sent no CA (a `berth host` thread). Leave trust as it is
   and let the rest of the resume run. Do not exit.
4. **When it is present and cannot be applied, fail loudly.** This covers a
   CA that cannot be read, a rebuild that fails, or a store that still lacks
   the CA afterwards. Print the reason to stderr and make the hook exit
   non-zero at its end, after its other steps. A failed resume hook does not
   stop the thread, but cube records the failure and shows its log
   (`cube hooks`).
5. **Be idempotent.** The section runs on every boot. On a machine that is
   already right, it must change no file, and each store must hold the CA
   once, never a second copy. Do the work only when the CA's SHA-256
   fingerprint is missing, then check again.
6. **Refresh a stale CA.** If a store holds an older runner CA, or another
   CA under the alias you use, replace it rather than add beside it.
7. **Keep the public roots.** Add the runner's CA next to them. Never create
   a store, never leave one that holds only the runner's CA, and never point
   a tool at such a store. Check after each change that the public roots are
   still there.
8. **Rebuild with the distribution's own tool, not by hand.** On Debian or
   Ubuntu, run `sudo update-ca-certificates --fresh`. It reads every public
   root plus `cube-runner.crt` and runs the hooks for derived stores,
   including Java's.
9. **Never bypass a check.** Do not use `-k`, `--insecure`,
   `NODE_TLS_REJECT_UNAUTHORIZED=0`, `GIT_SSL_NO_VERIFY`, `verify=False` or
   trust-all `TrustManager`s. Do not try to get past the template seal
   either: no hiding, compressing or encrypting a store that holds a
   runner CA.

## The resume section

The file has two parts. Put the first near the top of `.agents/resume`,
before any step that needs Java HTTPS. Put the last line at the very end of
the file. The file runs under `set -euo pipefail`, and the section itself
never exits.

The section does two things:

- It repairs Debian's or Ubuntu's system Java store (`ca-certificates-java`),
  if that is installed.
- It repairs each store listed in `jdk_stores`. That is the store of a JDK
  not installed through the distribution's packages, such as a Temurin
  tarball, SDKMAN, a Gradle or Maven toolchain, or an IDE runtime.
  `update-ca-certificates` never touches those. Each listed store must
  already exist with its public roots; the section refuses to create one.

```bash
#!/usr/bin/env bash
set -euo pipefail

# --- cube: trust in the runner's CA (never exits; see the last line) ---
ca=/etc/cube/ca.pem
jdk_stores=()   # bundled JDKs: their lib/security/cacerts, each must already exist
ca_error=""
if [ ! -e "$ca" ]; then
  echo "runner CA: none on this machine ($ca absent), trust left as it is"
elif ! want="$(openssl x509 -in "$ca" -noout -fingerprint -sha256 | cut -d= -f2)" || [ -z "$want" ]; then
  ca_error="cannot read $ca"
else
  # grep reads every line (no -q), so pipefail never sees keytool cut off.
  holds() { keytool -list -keystore "$1" -storepass changeit 2>/dev/null | grep "SHA-256): $want" >/dev/null; }
  entries() { keytool -list -keystore "$1" -storepass changeit 2>/dev/null | grep -c trustedCertEntry || true; }
  alias_fp() { keytool -list -keystore "$1" -storepass changeit -alias cube-runner 2>/dev/null \
    | sed -n 's/^Certificate fingerprint (SHA-256): //p' || true; }

  # Debian's Java store, derived from the system trust with every public root.
  java_store=/etc/ssl/certs/java/cacerts
  if [ -d /etc/ssl/certs/java ]; then
    if ! holds "$java_store"; then
      echo "runner CA: rebuilding the system trust stores"
      sudo update-ca-certificates --fresh >/dev/null || ca_error="update-ca-certificates --fresh failed"
    fi
    if [ -z "$ca_error" ] && ! { holds "$java_store" && [ "$(entries "$java_store")" -gt 1 ]; }; then
      ca_error="$java_store lacks the runner CA or its public roots"
    fi
  fi

  # Bundled JDKs: only a store that exists and holds public roots is changed.
  for store in "${jdk_stores[@]}"; do
    [ -z "$ca_error" ] || break
    before="$(entries "$store")"
    if [ ! -s "$store" ] || [ "$before" -le 1 ]; then
      ca_error="$store is missing or holds no public roots; not creating one"; break
    fi
    [ "$(alias_fp "$store")" != "$want" ] || continue
    echo "runner CA: importing into $store"
    if [ -n "$(alias_fp "$store")" ]; then
      keytool -delete -alias cube-runner -keystore "$store" -storepass changeit \
        || { ca_error="cannot remove the stale CA from $store"; break; }
    fi
    keytool -importcert -noprompt -alias cube-runner -file "$ca" -keystore "$store" -storepass changeit >/dev/null \
      || { ca_error="cannot import into $store"; break; }
    if [ "$(alias_fp "$store")" != "$want" ] || [ "$(entries "$store")" -lt "$before" ]; then
      ca_error="$store did not take the runner CA"; break
    fi
  done
fi
[ -z "$ca_error" ] || echo "runner CA: $ca_error" >&2
# --- end of the runner CA section ---

# ... the rest of .agents/resume ...

[ -z "$ca_error" ] || exit 1   # last line: the hook fails after its other steps
```

`changeit` is the JDK's well-known default store password, not a
credential. If `keytool` is not on `PATH` when resume runs, call it by its
full path. Run it with `sudo` for a root-owned bundled JDK.

`update-ca-certificates --fresh` also rewrites the system bundle. The
runner's CA stays in it (from `cube-runner.crt`), but without cube's marker
lines. keel adds its block again on the next boot, so the bundle then holds
the CA twice, both copies the same CA. That is harmless, and rebuilds and
repeated runs do not add more copies.

Instead of listing a bundled JDK, you may point its JVM at the Debian store.
Pass `-Djavax.net.ssl.trustStore=/etc/ssl/certs/java/cacerts` through the
tool's own JVM options, for example `org.gradle.jvmargs` in
`gradle.properties`, `.mvn/jvm.config`, or the IDE's VM options.

## Templates and the Java store

A template build whose setup installs `ca-certificates-java` writes
`/etc/ssl/certs/java/cacerts`, so the seal refuses that template today. This
skill does not give a way around that. No change to the build has been
through a real template build and publish. Do not import the runner's CA in
setup to "fix" it.

## Other tools with their own CA list

Most tools follow the four variables cube sets. For a tool that ignores
them, prefer its own setting that names the system bundle,
`/etc/ssl/certs/ca-certificates.crt`. Examples are `cafile=` in `.npmrc`, or
`cert` in `pip.conf`. Copying the CA into the tool's private bundle is the
last resort. If you must, do it in resume and follow rules 3 to 7. This
section was not tested tool by tool.

## Check it

```bash
openssl verify -no-CApath -no-CAstore -CAfile /etc/ssl/certs/ca-certificates.crt /etc/cube/ca.pem   # system bundle
keytool -list -keystore /etc/ssl/certs/java/cacerts -storepass changeit | grep -c trustedCertEntry   # public roots + 1
curl -fsS -o /dev/null https://repo1.maven.org/maven2/ && echo ok
```

The `-no-CApath -no-CAstore` flags matter. Without them, `openssl verify`
also searches `/etc/ssl/certs` and passes even when the given bundle lacks
the CA.

Afterwards, `cube hooks` shows the resume outcome and log.

## Not verified, or only proposed

- **Other distributions.** On Fedora or RHEL (`update-ca-trust`), keel
  writes no anchor under `/etc/pki/ca-trust/source/anchors`, so a rebuild
  there may drop the runner's CA from the bundle until the next boot.
  Alpine was not tested either. Before relying on a rebuild there, check
  with `openssl verify` above that the CA survives it.
- **A real template build** with a JDK has not been run with this skill.
- **Proposed only, not implemented:** a short-lived CA per template build,
  plus a trust rebuild that cube runs itself in template threads. This is a
  design note on the runner's CA and published templates, in project
  artifact `ea03ef64` (not a repository document). Until it lands, the
  project's own resume does the rebuild, as described here.
