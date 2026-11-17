#!/bin/sh
# Build the plugin and install it into the Desktop application's reserved profile.
#
# DeepSeek Harness Desktop must be fully quit first: its bundled CLI refuses to
# manage the profile while the application holds it, and an install cannot be
# picked up by a running window.
set -e

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CLI="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
TSC="$HERE/../deepseek-harness/node_modules/typescript/bin/tsc"

if [ ! -x "$CLI" ]; then
  echo "error: no Desktop CLI at $CLI" >&2
  echo "       adjust CLI= if DeepSeek Harness lives elsewhere." >&2
  exit 1
fi

if [ ! -f "$TSC" ]; then
  echo "error: no TypeScript compiler at $TSC" >&2
  echo "       it ships with the deepseek-harness checkout next to this project." >&2
  exit 1
fi

echo "building lib/ ..."
rm -rf "$HERE/lib"
node "$TSC" -p "$HERE/tsconfig.build.json"

echo "installing into the desktop profile ..."
"$CLI" plugin --profile desktop add "$HERE"

echo
echo "done. Now start DeepSeek Harness Desktop again."
echo "If it is still running, this install was rejected — quit it and re-run."
