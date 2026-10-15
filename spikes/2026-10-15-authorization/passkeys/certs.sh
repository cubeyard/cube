#!/usr/bin/env bash
# Local CA and one leaf for the simulated HTTPS names. Output in $1 (default /tmp/authz/pk).
set -euo pipefail
d=${1:-/tmp/authz/pk}; mkdir -p "$d"; cd "$d"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 7 \
  -subj "/CN=cube spike CA" -keyout ca.key -out ca.crt 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=cube spike leaf" \
  -keyout leaf.key -out leaf.csr 2>/dev/null
cat > leaf.ext <<X
basicConstraints=CA:FALSE
keyUsage=digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=DNS:server1.tail832c1.ts.net,DNS:cube.example.test,DNS:example.test,DNS:cube.example.com
X
openssl x509 -req -in leaf.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 7 -extfile leaf.ext -out leaf.crt 2>/dev/null
cat leaf.crt ca.crt > chain.crt
openssl x509 -in leaf.crt -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64 > leaf.spki
echo "spki $(cat leaf.spki)"
