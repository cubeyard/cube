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

HTTPS (port 443) out of a thread machine is terminated by the runner
and re-signed with the **runner's CA**. There is one CA per runner, valid for
10 years (`packages/berth/src/vm/ca.rs`). On every boot, keel's
`machine_setup` (`packages/keel/agent/src/generated.rs`) writes it to:

| where | what |
| --- | --- |
| `/etc/cube/ca.pem` | the CA, bind-mounted read only: **the source to read** |
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

The template seal (`packages/keel/agent/src/template.rs`, `seal_check`)
refuses a layer in either of these cases:

- a file still holds a runner CA (its DER, or the start of its base64);
- `/etc/ssl/certs/java/cacerts` is a file the build wrote, whatever it holds.

## Rules

1. **Add trust in `.agents/resume`, not in `.agents/setup`.** Resume runs on
   every boot of every thread machine, after setup, and never in a template
   build. So whatever it imports reaches the thread's disk and never the
   template.
2. **Read the CA from `/etc/cube/ca.pem` on every run**, and compare by
   SHA-256 fingerprint. Never copy the CA into the repository, a hook or a
   seed. It is not a secret, but it belongs to one runner.
3. **Rebuild with the distribution's own tool, not by hand.** On Debian or
   Ubuntu, run `sudo update-ca-certificates --fresh`. It reads every public
   root plus `cube-runner.crt` and runs the hooks for derived stores,
   including Java's.
4. **Make it idempotent and cheap.** Do the work only when the fingerprint
   is missing, and then check again. A second run must leave every file
   unchanged.
5. **Fail loudly.** Use `set -euo pipefail` and exit non-zero when the CA is
   still missing. A failed resume hook does not stop the thread, but cube
   records the failure and shows its log (`cube hooks`).
6. **Keep the public roots.** Add the runner's CA next to them. Never point
   a tool at a store that holds only the runner's CA, and never empty a
   store.
7. **Never bypass a check.** Do not use `-k`, `--insecure`,
   `NODE_TLS_REJECT_UNAUTHORIZED=0`, `GIT_SSL_NO_VERIFY`, `verify=False` or
   trust-all `TrustManager`s. Do not try to get past the template seal either: no hiding,
   compressing or encrypting a store that holds a runner CA.

## Debian or Ubuntu system Java (`ca-certificates-java`)

Add this to `.agents/resume`. It was tested in a Debian 13 thread machine
with `default-jdk-headless` (OpenJDK 21) in three states:

| state | result |
| --- | --- |
| keystore missing | rebuilt in 1.8 s |
| stale CA under Debian's alias | replaced |
| already right | 0.6 s, file byte-identical |

In each state the store ended with 151 entries (150 public roots plus the
runner's CA), and `java` reached `https://repo1.maven.org` with status 200.

```bash
#!/usr/bin/env bash
set -euo pipefail

want="$(openssl x509 -in /etc/cube/ca.pem -noout -fingerprint -sha256 | cut -d= -f2)"
# grep reads the whole listing (no -q), so pipefail never sees keytool cut off.
trusts() { [ -s "$1" ] && keytool -list -keystore "$1" -storepass changeit 2>/dev/null | grep "SHA-256): $want" >/dev/null; }

# Java's system store, which Debian derives from the system trust.
java_store=/etc/ssl/certs/java/cacerts
if [ -d /etc/ssl/certs/java ] || [ -e "$java_store" ]; then
  if ! trusts "$java_store"; then
    echo "rebuilding the system trust stores for the runner CA"
    sudo update-ca-certificates --fresh >/dev/null
  fi
  trusts "$java_store" || { echo "the runner CA is not in $java_store" >&2; exit 1; }
fi
```

`changeit` is the JDK's well-known default store password, not a
credential. If `keytool` is not on `PATH` when resume runs, call it by its
full path.

`update-ca-certificates --fresh` also rewrites the system bundle. The
runner's CA stays in it (from `cube-runner.crt`), but without cube's marker
lines. keel adds its block again on the next boot, so the bundle may then hold
the CA twice. That is harmless.

### A template build with `ca-certificates-java`

Installing `ca-certificates-java` in `.agents/setup` writes
`/etc/ssl/certs/java/cacerts`, and the seal then refuses the template.
Because the resume above rebuilds a missing store, the last line of
`.agents/setup` may delete it:

```bash
# last in .agents/setup: .agents/resume rebuilds this derived store on every thread
sudo rm -f /etc/ssl/certs/java/cacerts
```

This deletes the file; it does not get past the seal check, which still
reads every file. **Status:** this follows from `seal_check` in keel's
source, and the rebuild after the delete was tested. It has **not** been
run through a real template build and publish. Every other file that holds
the CA still fails the seal, and that is intended. Java is unusable between
this line and the thread's resume, so keep it last.

## A JDK with its own store

Any JDK not installed through the distribution's packages keeps its own
`lib/security/cacerts`, which `update-ca-certificates` never touches. That
includes Temurin tarballs, SDKMAN, Gradle or Maven toolchains, IDE runtimes
and `jlink` images. Without the runner's CA, it fails with PKIX errors. Pick
one of these:

- **Point the JVM at the system store.** Pass
  `-Djavax.net.ssl.trustStore=/etc/ssl/certs/java/cacerts` through the tool's
  own JVM options. Examples: `org.gradle.jvmargs` and `systemProp.*` in
  `gradle.properties`, `.mvn/jvm.config`, or the IDE's VM options. This
  needs the Debian store from the section above. Tested: a Temurin 21 JRE
  went from a PKIX failure to status 200.
- **Import into that store in `.agents/resume`.** Never do this in setup,
  where the import would end up in the template. Run it on each store:

```bash
# $store: the JDK's lib/security/cacerts; keytool from that JDK
want="$(openssl x509 -in /etc/cube/ca.pem -noout -fingerprint -sha256 | cut -d= -f2)"
have="$(keytool -list -keystore "$store" -storepass changeit -alias cube-runner 2>/dev/null \
  | sed -n 's/^Certificate fingerprint (SHA-256): //p' || true)"  # no alias yet: empty
if [ "$have" != "$want" ]; then
  [ -z "$have" ] || keytool -delete -alias cube-runner -keystore "$store" -storepass changeit
  keytool -importcert -noprompt -alias cube-runner -file /etc/cube/ca.pem -keystore "$store" -storepass changeit
fi
```

  Tested on a Temurin 21 JRE. The store started with 118 public roots and
  failed with PKIX errors. A stale `cube-runner` entry was replaced, leaving
  119 entries, and `java` returned 200. A second run left the file
  byte-identical. Use `sudo` if the JDK is root-owned. `keytool` may print
  "use -cacerts option"; that warning is harmless.

## Other tools with their own CA list

Most tools follow the four variables cube sets. For a tool that ignores
them, prefer its own setting that names the system bundle,
`/etc/ssl/certs/ca-certificates.crt`. Examples are `cafile=` in `.npmrc`, or
`cert` in `pip.conf`. Copying
the CA into the tool's private bundle is the last resort. If you must, do it
in resume, the same way as the `keytool` import above. This section was not
tested tool by tool.

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
- **A real template publish** with the `rm` line above was not run.
- **Proposed only, not implemented:** a short-lived CA per template build,
  plus a trust rebuild that cube runs itself in template threads. This is
  the design note "Runner-CA og publiserte maler" (artifact `ea03ef64`).
  Until it lands, the project's own resume does the rebuild, as described
  here.
