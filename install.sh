#!/usr/bin/env sh
# ============================================================================
# install.sh — install the prime dsh integration into a dsh harness home
# ============================================================================
# POSIX twin of install.ps1: copies plugins, profiles, and the agent preset
# into $DSH_HOME (default ~/.dsh) and appends the marker-delimited `prime:`
# settings section once. Idempotent; nothing outside the harness home is
# touched.
#
#   ./install.sh
#   DSH_HOME=/srv/dsh ./install.sh
# ============================================================================
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

copy_tree() {
  src=$1
  dst=$2
  mkdir -p "$dst"
  cp -R "$src/." "$dst/"
}

echo "prime dsh integration - installing into $DSH_HOME"

copy_tree "$REPO_ROOT/plugins/prime"            "$DSH_HOME/plugins/prime"
echo "  plugins/prime             installed"

for profile in prime-web prime-headless; do
  copy_tree "$REPO_ROOT/profiles/$profile"      "$DSH_HOME/profiles/$profile"
  echo "  profiles/$profile       installed"
done

copy_tree "$REPO_ROOT/agent-presets/prime-rlm"  "$DSH_HOME/.agent-presets/prime-rlm"
echo "  .agent-presets/prime-rlm installed"

SETTINGS="$DSH_HOME/settings.yaml"
if [ -f "$SETTINGS" ] && grep -q '# >>> prime-dsh-integration >>>' "$SETTINGS"; then
  echo "  settings.yaml           prime section already present - left untouched"
elif [ -f "$SETTINGS" ]; then
  printf '\n' >> "$SETTINGS"
  cat "$REPO_ROOT/settings-prime-section.yaml" >> "$SETTINGS"
  echo "  settings.yaml           prime section appended"
else
  cp "$REPO_ROOT/settings-prime-section.yaml" "$SETTINGS"
  echo "  settings.yaml           created with prime section"
fi

if command -v node >/dev/null 2>&1 && [ -f "$DSH_HOME/plugins/prime/tools/prime-ops.cjs" ]; then
  echo ""
  node "$DSH_HOME/plugins/prime/tools/prime-ops.cjs" selftest \
    && echo "selftest passed" \
    || echo "selftest FAILED - see output above" >&2
fi

echo ""
echo "Done. Next steps:"
echo "  headless:  dsh --profile prime-headless \"your task\""
echo "  web:       dsh --profile prime-web, then pick the 'Prime RLM' preset per session,"
echo "             or set  agent-presets: { default: prime-rlm }  in settings.yaml."
