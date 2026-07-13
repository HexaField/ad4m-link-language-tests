#!/usr/bin/env bash
# teardown.sh — Reclaim any interop infra left running, and ONLY that infra.
#
# Each verify-*.sh already tears down what it started on exit. This script is the
# safety net for two cases:
#   1. Backends pre-warmed by ./setup.sh (deliberately left running).
#   2. Backends leaked by a verify script that was hard-killed before its EXIT
#      trap ran.
#
# It is driven entirely by the on-disk markers under $INFRA_STATE_DIR (see
# infra-lib.sh). A backend that was REUSED (already running when a script found
# it) never gets a marker, so this script never touches it — your persistent
# relays / PDS / IPFS nodes and any system containers are left exactly as found.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

header "AD4M Link Language Interop — Teardown"

# ─── Remove test perspectives from the executor ──────────────────────────────
# Best-effort: the executor may not be running, which is fine.

step "Cleaning up test perspectives..."
perspectives=$(ad4m_rpc perspective-all 2>/dev/null) || perspectives="[]"
echo "$perspectives" | jq -r '.[] | select(.name // "" | startswith("interop-")) | .uuid' 2>/dev/null | while read -r uuid; do
    if [[ -n "$uuid" ]]; then
        info "Removing perspective $uuid"
        ad4m_rpc perspective-remove "$uuid" >/dev/null 2>&1 || true
    fi
done
success "Test perspectives cleaned up (best-effort)"

# ─── Reclaim marker-tracked backends (started by us, never reused ones) ───────

step "Reclaiming interop backends via markers ($INFRA_STATE_DIR)..."
infra_teardown_markers
success "Marker-tracked backends reclaimed"

header "Teardown Complete"
echo "Only infra started by these scripts was removed."
echo "Reused/pre-existing services and the AD4M executor were left untouched."
