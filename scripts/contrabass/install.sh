#!/usr/bin/env bash
# Build and install contrabass with this repo's patches (see README.md here).
set -euo pipefail
VERSION=v0.5.1
HERE=$(cd "$(dirname "$0")" && pwd)
MOD=github.com/junhoyeo/contrabass
SRC=$(mktemp -d)
trap 'rm -rf "$SRC"' EXIT
go mod download "$MOD@$VERSION"
cp -r "$(go env GOMODCACHE)/$MOD@$VERSION/." "$SRC"
chmod -R u+w "$SRC"
cd "$SRC"
for p in "$HERE"/*.patch; do
  sed 's/\r$//' "$p" | patch -p1 --no-backup-if-mismatch
done
sed 's/\r$//' "$HERE/release_paused_test.go" > internal/orchestrator/release_paused_test.go
go test ./internal/orchestrator/
go build -o "$(go env GOPATH)/bin/contrabass" ./cmd/contrabass
echo "installed contrabass $VERSION + patches to $(go env GOPATH)/bin/contrabass"
