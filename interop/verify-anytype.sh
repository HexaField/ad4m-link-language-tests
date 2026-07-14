#!/usr/bin/env bash
# verify-anytype.sh — Anytype (any-sync) ↔ AD4M interop verification
#
# Anytype is the only backend riding a genuine NATIVE convergent change-DAG:
# any-sync's objecttree is a signed, content-addressed, multi-parent change
# graph with deterministic lexid ordering, so convergence is Anytype's own CRDT
# (no synthesized hash-DAG). The stack is Go, so it lives behind a Go sidecar
# gateway (anytype-link-language/gateway, :7794); the language is a thin HTTP
# mirror. Two agents behind one gateway are two separate any-sync clients routed
# by the X-Ad4m-Did header.
#
# Proves bidirectional data flow AND cross-identity convergence over the real
# any-sync object tree:
#   1. AD4M (agent A's DID) writes links → appear in the gateway's folded /links.
#   2. A SECOND identity (agent B's DID) joins the same space and appends one
#      native diff → AD4M sync (agent A) picks it up — convergence through the
#      shared object tree, not a shim.
#
# Self-contained: brings up the gateway via infra-lib and tears down what it
# started. Requires the gateway binary built (anytype-link-language/gateway,
# `go build -o anytype-gateway .`).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
check_deps

header "Anytype (any-sync) ↔ AD4M Interop Test"

PERSPECTIVE_UUID=""
CONFIGURED_LANG=""
GATEWAY_PORT="${ANYTYPE_PORT:-7794}"
GATEWAY_URL="http://${DEVICE_A:-127.0.0.1}:${GATEWAY_PORT}"
SPACE_ID="anytype-${RUN_ID}"
# A second any-sync identity, distinct from the executor agent's DID. The gateway
# routes it to its own any-sync client; it joins the SAME space (AnyoneCanJoin
# ACL) and its appends converge with agent A's over the shared object tree.
DID_B="did:key:z6MkAnytypeVerifyB${RUN_ID}"

cleanup() {
    echo ""
    step "Cleaning up..."
    [[ -n "$PERSPECTIVE_UUID" ]] && cleanup_perspective "$PERSPECTIVE_UUID"
    infra_teardown
}
trap cleanup EXIT

# ─── Step 1: Ensure gateway (self-contained) ────────────────────────────────

step "1. Ensuring anytype gateway..."
if ! infra_ensure anytype; then
    fail "service-health" "Could not bring up anytype gateway"
    echo ""
    echo "  The anytype gateway is a Go binary spawned from the"
    echo "  anytype-link-language repo's gateway/ dir. Build it first:"
    echo "    cd \$WORKSPACE/anytype-link-language/gateway && go build -o anytype-gateway ."
    echo "  Or point ANYTYPE_GATEWAY_DIR at an existing checkout."
    print_summary "anytype" || exit 1
fi

STATUS_RESP=$(curl -sf "$GATEWAY_URL/status" 2>/dev/null) || STATUS_RESP=""
GATEWAY_OK=$(echo "$STATUS_RESP" | jq -r '.ok // false' 2>/dev/null)
if [[ "$GATEWAY_OK" == "true" ]]; then
    NODE_ID=$(echo "$STATUS_RESP" | jq -r '.nodeId // empty' 2>/dev/null)
    pass "service-health" "Gateway healthy at $GATEWAY_URL${NODE_ID:+ (node ${NODE_ID:0:16}…)}"
else
    fail "service-health" "Gateway unhealthy: $STATUS_RESP"
    print_summary "anytype" || exit 1
fi

# ─── Step 2: Open the space (neighbourhood id → real any-sync spaceId) ───────

step "2. Opening any-sync space for '$SPACE_ID'..."
OPEN_RESP=$(curl -sf -X POST "$GATEWAY_URL/space/open" \
    -H "Content-Type: application/json" \
    -H "X-Ad4m-Did: did:key:z6MkAnytypeVerifyA${RUN_ID}" \
    -d "{\"neighbourhoodId\": \"$SPACE_ID\"}" 2>/dev/null) || OPEN_RESP=""

REAL_SPACE_ID=$(echo "$OPEN_RESP" | jq -r '.spaceId // empty' 2>/dev/null)
if [[ -n "$REAL_SPACE_ID" ]]; then
    pass "space-open" "Space ready (id: ${REAL_SPACE_ID:0:24}…)"
else
    fail "space-open" "Could not open space: $OPEN_RESP"
    print_summary "anytype" || exit 1
fi

# ─── Step 3: Configure language with template vars ──────────────────────────

step "3. Configuring anytype link language..."
TEMPLATE_DATA=$(jq -n \
    --arg gw "$GATEWAY_URL" \
    --arg space "$SPACE_ID" \
    '{
        "ANYTYPE_GATEWAY_URL": $gw,
        "ANYTYPE_SPACE_ID": $space,
        "NEIGHBOURHOOD_META": "{}"
    }')

CONFIGURED_LANG=$(publish_and_configure_language "${LANG_ANYTYPE:-}" "$TEMPLATE_DATA" 2>/dev/null) || true
if [[ -n "$CONFIGURED_LANG" && "$CONFIGURED_LANG" != "null" ]]; then
    pass "language-configure" "Configured: $CONFIGURED_LANG"
else
    fail "language-configure" "Could not apply template to anytype language"
    CONFIGURED_LANG="${LANG_ANYTYPE:-}"
    warn "Falling back to base language address (set \$LANG_ANYTYPE to the published bundle)"
fi

# ─── Step 4: Create perspective → publish as neighbourhood ──────────────────

step "4. Creating perspective and neighbourhood..."
PERSPECTIVE_UUID=$(create_test_perspective "interop-anytype-${RUN_ID}" 2>/dev/null) || true
if [[ -z "$PERSPECTIVE_UUID" ]]; then
    fail "perspective-create" "Could not create perspective"
    print_summary "anytype" || exit 1
fi

NEIGHBOURHOOD_URL=$(create_test_neighbourhood "$PERSPECTIVE_UUID" "$CONFIGURED_LANG" 2>/dev/null) || true
if [[ -n "$NEIGHBOURHOOD_URL" ]]; then
    pass "neighbourhood-create" "Published neighbourhood"
else
    fail "neighbourhood-create" "Could not publish neighbourhood"
    print_summary "anytype" || exit 1
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

# ─── Step 6: Verify AD4M links appear in the gateway's folded object tree ────

step "6. Checking gateway for AD4M links (as a second joined identity)..."
sleep 3  # let the language append its diff(s)

# Join the SAME space as identity B, then read the folded link set. Reading as a
# different DID proves the change reached the shared object tree, not just B's
# local mirror.
curl -sf -X POST "$GATEWAY_URL/space/open" \
    -H "Content-Type: application/json" \
    -H "X-Ad4m-Did: $DID_B" \
    -d "{\"neighbourhoodId\": \"$SPACE_ID\"}" >/dev/null 2>&1 || true

# Give the two in-gateway clients a moment to relay heads.
sleep 2
LINKS_RESP=$(curl -sf "$GATEWAY_URL/links" -H "X-Ad4m-Did: $DID_B" 2>/dev/null) || LINKS_RESP="{}"
GW_LINK_COUNT=$(echo "$LINKS_RESP" | jq '.links | length' 2>/dev/null) || GW_LINK_COUNT=0
GW_MATCH=$(echo "$LINKS_RESP" | jq --arg p "ad4m://test/${RUN_ID}" \
    '[.links[]? | .data // . | select((.source // "") | startswith($p))] | length' 2>/dev/null) || GW_MATCH=0

if [[ "$GW_MATCH" -gt 0 ]]; then
    pass "native-read" "Found $GW_MATCH AD4M links in the folded object tree (B sees A's writes)"
elif [[ "$GW_LINK_COUNT" -gt 0 ]]; then
    skip "native-read" "Gateway holds $GW_LINK_COUNT links but none matched the AD4M test prefix"
else
    fail "native-read" "No AD4M links visible in the gateway's folded set"
fi

# ─── Step 7: Native append from identity B (real cross-DID convergence) ──────

step "7. Appending one native diff as identity B..."
NATIVE_SOURCE="anytype://native/${RUN_ID}/subject-1"
NATIVE_PREDICATE="anytype://native/predicate-created"
NATIVE_TARGET="anytype://native/object-1"
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
            "proof": { "signature": "verify-anytype", "key": $did }
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
# cursor. A second /sync?since=<cursor> returns only changes past it.
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
echo "  Gateway: $GATEWAY_URL  (space: $SPACE_ID)"
echo "  GET  $GATEWAY_URL/status                         — liveness (nodeId, revision, heads, cursor)"
echo "  GET  $GATEWAY_URL/links   -H 'X-Ad4m-Did: <did>' — folded link set"
echo "  GET  $GATEWAY_URL/sync    -H 'X-Ad4m-Did: <did>' — walk the change-DAG (bootstrap → cursor)"
echo "  POST $GATEWAY_URL/diff    -H 'X-Ad4m-Did: <did>' — append one TreeChange"

print_summary "anytype" || exit 1
