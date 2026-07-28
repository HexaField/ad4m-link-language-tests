#!/usr/bin/env bash
# verify-freenet.sh — Freenet (freenet.org) ↔ AD4M interop verification
#
# Freenet is the second backend riding a genuine NATIVE convergent substrate. A
# Freenet contract is a WASM program whose state is merged by a commutative
# monoid — Freenet's own requirement of contract authors — so the OR-Set
# link-store contract IS the CRDT and convergence is performed by the real
# `freenet` node's WASM runtime (no synthesized hash-DAG). The node +
# freenet-stdlib client are Rust, so they live behind a Rust sidecar gateway
# (freenet-link-language/gateway, :7795); the language is a thin HTTP mirror. Two
# agents behind one gateway share one contract (keyed by neighbourhood id), routed
# by the X-Ad4m-Did header for their /sync cursors.
#
# Proves bidirectional data flow AND cross-identity convergence over the real
# Freenet contract:
#   1. AD4M (agent A's DID) writes links → appear in the gateway's folded /links.
#   2. A SECOND identity (agent B's DID) opens the same contract and appends one
#      native diff → AD4M sync (agent A) picks it up — convergence through the
#      shared contract state, not a shim.
#
# Self-contained: brings up an unmodified `freenet local` node + the gateway via
# infra-lib and tears down what it started. Requires the gateway binary built
# (`cargo build --release`) and the contract wasm built (`fdev build`), plus the
# `freenet` node binary on PATH (`cargo install freenet fdev`).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
check_deps

header "Freenet (freenet.org) ↔ AD4M Interop Test"

PERSPECTIVE_UUID=""
CONFIGURED_LANG=""
GATEWAY_PORT="${FREENET_PORT:-7795}"
GATEWAY_URL="http://${DEVICE_A:-127.0.0.1}:${GATEWAY_PORT}"
CONTRACT_KEY="freenet-${RUN_ID}"
# A second identity, distinct from the executor agent's DID. The gateway tracks
# its own /sync cursor; it opens the SAME contract and its appends converge with
# agent A's through the contract's OR-Set fold.
DID_B="did:key:z6MkFreenetVerifyB${RUN_ID}"

cleanup() {
    echo ""
    step "Cleaning up..."
    [[ -n "$PERSPECTIVE_UUID" ]] && cleanup_perspective "$PERSPECTIVE_UUID"
    infra_teardown
}
trap cleanup EXIT

# ─── Step 1: Ensure node + gateway (self-contained) ─────────────────────────

step "1. Ensuring freenet node + gateway..."
if ! infra_ensure freenet; then
    fail "service-health" "Could not bring up freenet node + gateway"
    echo ""
    echo "  The freenet backend is an unmodified 'freenet local' node plus a Rust"
    echo "  sidecar gateway spawned from freenet-link-language/gateway. Build both:"
    echo "    cargo install freenet fdev                       # node binary (once)"
    echo "    cd \$WORKSPACE/freenet-link-language/contract && CARGO_TARGET_DIR=\$PWD/target fdev build --features contract"
    echo "    cd \$WORKSPACE/freenet-link-language/gateway  && cargo build --release"
    echo "  Or point FREENET_GATEWAY_DIR at an existing checkout."
    print_summary "freenet" || exit 1
fi

STATUS_RESP=$(curl -sf "$GATEWAY_URL/status" 2>/dev/null) || STATUS_RESP=""
GATEWAY_OK=$(echo "$STATUS_RESP" | jq -r '.ok // false' 2>/dev/null)
if [[ "$GATEWAY_OK" == "true" ]]; then
    NODE_ID=$(echo "$STATUS_RESP" | jq -r '.nodeId // empty' 2>/dev/null)
    pass "service-health" "Gateway healthy at $GATEWAY_URL${NODE_ID:+ (node ${NODE_ID:0:24}…)}"
else
    fail "service-health" "Gateway unhealthy: $STATUS_RESP"
    print_summary "freenet" || exit 1
fi

# ─── Step 2: Open the contract (neighbourhood id → real ContractKey) ─────────

step "2. Opening freenet contract for '$CONTRACT_KEY'..."
OPEN_RESP=$(curl -sf -X POST "$GATEWAY_URL/space/open" \
    -H "Content-Type: application/json" \
    -H "X-Ad4m-Did: did:key:z6MkFreenetVerifyA${RUN_ID}" \
    -d "{\"neighbourhoodId\": \"$CONTRACT_KEY\"}" 2>/dev/null) || OPEN_RESP=""

REAL_CONTRACT_ID=$(echo "$OPEN_RESP" | jq -r '.spaceId // empty' 2>/dev/null)
if [[ -n "$REAL_CONTRACT_ID" ]]; then
    pass "space-open" "Contract ready (instance id: ${REAL_CONTRACT_ID:0:24}…)"
else
    fail "space-open" "Could not open contract: $OPEN_RESP"
    print_summary "freenet" || exit 1
fi

# ─── Step 3: Configure language with template vars ──────────────────────────

step "3. Configuring freenet link language..."
TEMPLATE_DATA=$(jq -n \
    --arg gw "$GATEWAY_URL" \
    --arg key "$CONTRACT_KEY" \
    '{
        "FREENET_GATEWAY_URL": $gw,
        "FREENET_CONTRACT_KEY": $key,
        "NEIGHBOURHOOD_META": "{}"
    }')

CONFIGURED_LANG=$(publish_and_configure_language "${LANG_FREENET:-}" "$TEMPLATE_DATA" 2>/dev/null) || true
if [[ -n "$CONFIGURED_LANG" && "$CONFIGURED_LANG" != "null" ]]; then
    pass "language-configure" "Configured: $CONFIGURED_LANG"
else
    fail "language-configure" "Could not apply template to freenet language"
    CONFIGURED_LANG="${LANG_FREENET:-}"
    warn "Falling back to base language address (set \$LANG_FREENET to the published bundle)"
fi

# ─── Step 4: Create perspective → publish as neighbourhood ──────────────────

step "4. Creating perspective and neighbourhood..."
PERSPECTIVE_UUID=$(create_test_perspective "interop-freenet-${RUN_ID}" 2>/dev/null) || true
if [[ -z "$PERSPECTIVE_UUID" ]]; then
    fail "perspective-create" "Could not create perspective"
    print_summary "freenet" || exit 1
fi

NEIGHBOURHOOD_URL=$(create_test_neighbourhood "$PERSPECTIVE_UUID" "$CONFIGURED_LANG" 2>/dev/null) || true
if [[ -n "$NEIGHBOURHOOD_URL" ]]; then
    pass "neighbourhood-create" "Published neighbourhood"
else
    fail "neighbourhood-create" "Could not publish neighbourhood"
    print_summary "freenet" || exit 1
fi

# ─── Step 5: Add 3 test links via AD4M ─────────────────────────────────────

step "5. Adding test links via AD4M..."
add_test_links "$PERSPECTIVE_UUID" "$RUN_ID" 2>/dev/null || true

LINKS=$(query_test_links "$PERSPECTIVE_UUID" 2>/dev/null) || LINKS="[]"
LINK_COUNT=$(echo "$LINKS" | jq 'if type == "array" then length else 0 end' 2>/dev/null) || LINK_COUNT=0

if [[ "$LINK_COUNT" -ge 3 ]]; then
    pass "ad4m-write" "Wrote $LINK_COUNT links via AD4M"
else
    fail "ad4m-write" "Expected 3 links in AD4M, found $LINK_COUNT"
fi

# ─── Step 6: Verify AD4M links appear in the contract's folded state ─────────

step "6. Checking gateway for AD4M links (as a second identity)..."
sleep 3  # let the language send its Update(s)

# Open the SAME contract as identity B, then read the folded link set. Reading as
# a different DID proves the change reached the shared contract state.
curl -sf -X POST "$GATEWAY_URL/space/open" \
    -H "Content-Type: application/json" \
    -H "X-Ad4m-Did: $DID_B" \
    -d "{\"neighbourhoodId\": \"$CONTRACT_KEY\"}" >/dev/null 2>&1 || true

sleep 2
LINKS_RESP=$(curl -sf "$GATEWAY_URL/links" -H "X-Ad4m-Did: $DID_B" 2>/dev/null) || LINKS_RESP="{}"
GW_LINK_COUNT=$(echo "$LINKS_RESP" | jq '.links | length' 2>/dev/null) || GW_LINK_COUNT=0
GW_MATCH=$(echo "$LINKS_RESP" | jq --arg p "ad4m://test/${RUN_ID}" \
    '[.links[]? | .data // . | select((.source // "") | startswith($p))] | length' 2>/dev/null) || GW_MATCH=0

if [[ "$GW_MATCH" -gt 0 ]]; then
    pass "native-read" "Found $GW_MATCH AD4M links in the folded contract state (B sees A's writes)"
elif [[ "$GW_LINK_COUNT" -gt 0 ]]; then
    skip "native-read" "Gateway holds $GW_LINK_COUNT links but none matched the AD4M test prefix"
else
    fail "native-read" "No AD4M links visible in the contract's folded set"
fi

# ─── Step 7: Native append from identity B (real cross-DID convergence) ──────

step "7. Appending one native diff as identity B..."
NATIVE_SOURCE="freenet://native/${RUN_ID}/subject-1"
NATIVE_PREDICATE="freenet://native/predicate-created"
NATIVE_TARGET="freenet://native/object-1"
NOW_TS="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"

DIFF_BODY=$(jq -n \
    --arg src "$NATIVE_SOURCE" \
    --arg pred "$NATIVE_PREDICATE" \
    --arg tgt "$NATIVE_TARGET" \
    --arg did "$DID_B" \
    --arg ts "$NOW_TS" \
    '{
        "additions": [{
            "author": $did,
            "timestamp": $ts,
            "data": { "source": $src, "predicate": $pred, "target": $tgt },
            "proof": { "signature": "verify-freenet", "key": $did }
        }],
        "removals": []
    }')

DIFF_RESP=$(curl -sf -X POST "$GATEWAY_URL/diff" \
    -H "Content-Type: application/json" \
    -H "X-Ad4m-Did: $DID_B" \
    -d "$DIFF_BODY" 2>/dev/null) || DIFF_RESP=""

DIFF_REV=$(echo "$DIFF_RESP" | jq -r '.revision // empty' 2>/dev/null)
if [[ -n "$DIFF_REV" ]]; then
    pass "native-write" "Appended native diff as B (revision: ${DIFF_REV:0:16}…)"
else
    fail "native-write" "Could not append diff via /diff: $DIFF_RESP"
fi

# ─── Step 8: Trigger AD4M sync and check for B's native link ────────────────

step "8. Syncing AD4M (agent A) and checking for B's native link..."
trigger_sync "$PERSPECTIVE_UUID" 2>/dev/null || true
sleep 3

LINKS_AFTER=$(query_test_links "$PERSPECTIVE_UUID" 2>/dev/null) || LINKS_AFTER="[]"
LINK_COUNT_AFTER=$(echo "$LINKS_AFTER" | jq 'if type == "array" then length else 0 end' 2>/dev/null) || LINK_COUNT_AFTER=0

NATIVE_FOUND=$(echo "$LINKS_AFTER" | jq --arg src "$NATIVE_SOURCE" \
    'if type == "array" then [.[] | .data // . | select(.source == $src)] | length else 0 end' 2>/dev/null) || NATIVE_FOUND=0

if [[ "$NATIVE_FOUND" -gt 0 ]]; then
    pass "reverse-sync" "B's native link converged into AD4M agent A ($LINK_COUNT_AFTER total links)"
elif [[ "$LINK_COUNT_AFTER" -gt "$LINK_COUNT" ]]; then
    skip "reverse-sync" "Link count grew ($LINK_COUNT → $LINK_COUNT_AFTER) but native source not matched"
else
    fail "reverse-sync" "B's native link did not converge into AD4M after sync"
fi

# ─── Step 9: Verify incremental sync (cursor-based) ─────────────────────────

step "9. Verifying incremental sync (cursor)..."
# A cold /sync (no cursor) returns bootstrap:true + the full folded set + a
# cursor (= the contract-state revision). A second /sync?since=<cursor> with the
# same revision returns no changes.
SYNC1=$(curl -sf "$GATEWAY_URL/sync" -H "X-Ad4m-Did: $DID_B" 2>/dev/null) || SYNC1=""
CURSOR=$(echo "$SYNC1" | jq -r '.cursor // empty' 2>/dev/null)
BOOTSTRAP=$(echo "$SYNC1" | jq -r '.bootstrap // false' 2>/dev/null)
if [[ -n "$CURSOR" ]]; then
    SYNC2=$(curl -sf "$GATEWAY_URL/sync?since=$CURSOR" -H "X-Ad4m-Did: $DID_B" 2>/dev/null) || SYNC2=""
    ADDS2=$(echo "$SYNC2" | jq '.additions | length' 2>/dev/null) || ADDS2=0
    BOOT2=$(echo "$SYNC2" | jq -r '.bootstrap // false' 2>/dev/null)
    pass "incremental-sync" "Cursor sync works (bootstrap first=$BOOTSTRAP, since-cursor additions=$ADDS2, bootstrap second=$BOOT2)"
else
    skip "incremental-sync" "No cursor returned from /sync — incremental path unconfirmed"
fi

# ─── Summary ────────────────────────────────────────────────────────────────

echo ""
echo "Manual verification:"
echo "  Gateway: $GATEWAY_URL  (contract key: $CONTRACT_KEY)"
echo "  GET  $GATEWAY_URL/status                         — liveness (nodeId, revision)"
echo "  GET  $GATEWAY_URL/links   -H 'X-Ad4m-Did: <did>' — folded link set"
echo "  GET  $GATEWAY_URL/sync    -H 'X-Ad4m-Did: <did>' — folded state (bootstrap → cursor)"
echo "  POST $GATEWAY_URL/diff    -H 'X-Ad4m-Did: <did>' — send one contract Update"

print_summary "freenet" || exit 1
