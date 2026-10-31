#!/bin/sh
# Enables the repository hooks for this clone (git does not clone hook config).
set -eu
cd "$(dirname "$0")/.."
git config core.hooksPath .githooks
chmod +x .githooks/*
echo "hooks enabled: $(git config core.hooksPath)"
