#!/usr/bin/env bash
# Installs the two reviewers' scanners at pinned versions, each checked against its published SHA-256, into
# ./.tools/bin (CI: the security job). Linux x86-64 only.
set -euo pipefail

TRIVY_VERSION=0.71.0
TRIVY_SHA256=30a3d22b23f88c233f1658f562fb477cae3b3e8b4761109d515b7698daf85814
OPENGREP_VERSION=1.31.0
OPENGREP_SHA256=dbbe3c2058dbe600c449a8ba22ea79a1643a6660658400090d0323a8d0d31147

BIN="${1:-$PWD/.tools/bin}"
mkdir -p "$BIN"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL -o "$tmp/trivy.tar.gz" \
  "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz"
echo "${TRIVY_SHA256}  $tmp/trivy.tar.gz" | sha256sum -c -
tar -xzf "$tmp/trivy.tar.gz" -C "$tmp" trivy
install -m 0755 "$tmp/trivy" "$BIN/trivy"

curl -fsSL -o "$tmp/opengrep" \
  "https://github.com/opengrep/opengrep/releases/download/v${OPENGREP_VERSION}/opengrep_manylinux_x86"
echo "${OPENGREP_SHA256}  $tmp/opengrep" | sha256sum -c -
install -m 0755 "$tmp/opengrep" "$BIN/opengrep"

"$BIN/trivy" --version | head -1
"$BIN/opengrep" --version
