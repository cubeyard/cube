#!/usr/bin/env bash
# Builds the Elm prototype into packages/web-elm/dist. ELM names the compiler
# (default: elm on PATH); `npm install elm@0.19.1-6` in a scratch directory gives one.
set -euo pipefail
cd "$(dirname "$0")"
"${ELM:-elm}" make src/Main.elm --optimize --output=dist/elm.js
cp static/index.html static/boot.js static/app.css static/archivo-latin.woff2 dist/
echo "built $(pwd)/dist"
