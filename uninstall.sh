#!/usr/bin/env sh
# ============================================================================
# uninstall.sh — remove the prime dsh integration from a dsh harness home
# ============================================================================
# Deletes the installed plugins, profiles, and agent preset, and strips the
# marker-delimited `prime:` settings block. Journals/artifacts under
# $DSH_HOME/storages/prime are KEPT unless PURGE=1.
#
#   ./uninstall.sh
#   PURGE=1 ./uninstall.sh
# ============================================================================
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PURGE="${PURGE:-0}"

for target in \
  "$DSH_HOME/plugins/prime" \
  "$DSH_HOME/profiles/prime-web" \
  "$DSH_HOME/profiles/prime-headless" \
  "$DSH_HOME/.agent-presets/prime-rlm"; do
  if [ -e "$target" ]; then
    rm -rf "$target"
    echo "removed $target"
  fi
done

SETTINGS="$DSH_HOME/settings.yaml"
if [ -f "$SETTINGS" ] && grep -q '# >>> prime-dsh-integration >>>' "$SETTINGS"; then
  tmp="$SETTINGS.tmp"
  sed '/# >>> prime-dsh-integration >>>/,/# <<< prime-dsh-integration <<</d' "$SETTINGS" > "$tmp"
  mv "$tmp" "$SETTINGS"
  echo "removed prime section from $SETTINGS"
else
  echo "no prime section found in $SETTINGS"
fi

if [ "$PURGE" = "1" ]; then
  # Destructive and irreversible: interactive sessions must type PURGE;
  # non-interactive sessions (piped stdin) must set CONFIRM_PURGE=1.
  if [ -t 0 ] && [ "${CONFIRM_PURGE:-0}" != "1" ]; then
    printf "This permanently deletes journals/artifacts under %s. Type PURGE to confirm: " "$DSH_HOME/storages/prime"
    read -r answer
    if [ "$answer" != "PURGE" ]; then
      echo "aborted - data kept"
      exit 1
    fi
  elif [ "${CONFIRM_PURGE:-0}" != "1" ]; then
    echo "PURGE with redirected stdin requires CONFIRM_PURGE=1" >&2
    exit 1
  fi
  rm -rf "$DSH_HOME/storages/prime"
  echo "purged $DSH_HOME/storages/prime"
else
  echo "kept $DSH_HOME/storages/prime (journals, artifacts, refinements). Set PURGE=1 to delete."
fi

echo "prime integration uninstalled. Default dsh profiles were never modified."
