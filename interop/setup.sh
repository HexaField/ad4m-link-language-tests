#!/usr/bin/env bash
# setup.sh — OPTIONAL pre-warm for AD4M interop testing.
#
# The verify-*.sh scripts are self-contained: each one brings up exactly the
# backend it needs and tears it down on exit (see infra-lib.sh). You do NOT need
# to run this script first.
#
# Its only job is an optimisation for BATCH runs: pre-warm every backend once so
# a `for f in verify-*.sh` loop reuses the already-running instances instead of
# spinning each backend up and down per script. Backends started here are left
# running with on-disk markers under $INFRA_STATE_DIR; reclaim them afterwards
# with ./teardown.sh.
#
# Idempotency-to-system-processes: pre-warm calls infra_ensure, which REUSES any
# backend that is already reachable (no marker, never torn down). A relay/PDS/
# IPFS node you run for other purposes is left exactly as found.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
check_deps

header "AD4M Link Language Interop — Pre-warm"

# All backends with provisionable infra. Protocols with no external infra
# (activitypub, git, expression-*, holochain) are self-contained in the executor
# and intentionally absent here.
PREWARM_PROTOS=(nostr matrix solid atproto ipfs hypercore nextgraph peer2panda anytype)

UP=0
TOTAL=${#PREWARM_PROTOS[@]}
FAILED=()

for proto in "${PREWARM_PROTOS[@]}"; do
    if infra_ensure "$proto"; then
        ((UP++)) || true
    else
        FAILED+=("$proto")
    fi
done

echo ""
info "$UP/$TOTAL backends ready"
if (( ${#FAILED[@]} > 0 )); then
    warn "Not pre-warmed: ${FAILED[*]}"
    info "Gateways (hypercore/nextgraph/peer2panda) must be built first; see each"
    info "repo's gateway/ dir. verify-<proto>.sh will still try on its own."
fi

# ─── AD4M Executor (system-under-test — provisioned externally) ──────────────
# The executor is NOT infra we manage: it is the thing being tested. It must be
# running with the link languages installed before any verify script can pass.

header "Checking AD4M Executor"
if wait_executor 15; then
    header "Verifying Language Installations"
    for lang_var in LANG_MATRIX LANG_ATPROTO LANG_SOLID LANG_IPFS LANG_NOSTR \
                    LANG_HYPERCORE LANG_NEXTGRAPH LANG_PEER2PANDA LANG_ANYTYPE; do
        lang_addr="${!lang_var:-}"
        lang_name="${lang_var#LANG_}"
        [[ -z "$lang_addr" ]] && { warn "$lang_name language address not set (\$$lang_var)"; continue; }
        result=$(ad4m_rpc language-get "$lang_addr" 2>/dev/null) || true
        addr=$(echo "$result" | jq -r '.address // empty' 2>/dev/null) || true
        if [[ -n "$addr" && "$addr" != "null" ]]; then
            success "$lang_name language found"
        else
            warn "$lang_name language NOT found — verify-${lang_name,,}.sh may fail"
        fi
    done
else
    warn "AD4M executor not reachable at ws://${AD4M_HOST}:${AD4M_PORT}"
    warn "Start it (with the link languages installed) before running verify scripts."
fi

# ─── Done ────────────────────────────────────────────────────────────────────

header "Pre-warm Complete"
echo "Pre-warmed backends are left running. Reclaim them with:"
echo "  ./teardown.sh"
echo ""
echo "Run individual tests (each is self-contained — reuses the pre-warm):"
echo "  ./verify-nostr.sh   ./verify-matrix.sh    ./verify-solid.sh"
echo "  ./verify-atproto.sh ./verify-ipfs.sh      ./verify-hypercore.sh"
echo "  ./verify-nextgraph.sh  ./verify-peer2panda.sh  ./verify-anytype.sh"
echo ""
echo "Or run all:"
echo "  for f in verify-*.sh; do ./\$f; done && ./teardown.sh"
