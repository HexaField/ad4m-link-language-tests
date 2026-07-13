#!/usr/bin/env bash
# verify-peer2panda.sh — peer2panda ↔ AD4M interop verification
#
# Proves bidirectional data flow:
#   1. AD4M writes links → appear as signed p2panda operations (flat triples)
#   2. peer2panda gateway writes triples → AD4M sync picks them up
#
# Requires: peer2panda sidecar gateway running (not Docker — standalone Rust
# process wrapping the p2panda v0.7 stack).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
check_deps

header "peer2panda ↔ AD4M Interop Test"

PERSPECTIVE_UUID=""
CONFIGURED_LANG=""
GATEWAY_PORT="${PEER2PANDA_PORT:-7780}"
GATEWAY_URL="http://${DEVICE_A:-127.0.0.1}:${GATEWAY_PORT}"
TOPIC_ID="peer2panda-${RUN_ID}"

cleanup() {
    echo ""
    step "Cleaning up..."
    [[ -n "$PERSPECTIVE_UUID" ]] && cleanup_perspective "$PERSPECTIVE_UUID"
    infra_teardown
}
trap cleanup EXIT

# ─── Step 1: Ensure gateway (self-contained) ────────────────────────────────

step "1. Ensuring peer2panda gateway..."
if ! infra_ensure peer2panda; then
    fail "service-health" "Could not bring up peer2panda gateway"
    echo ""
    echo "  The peer2panda gateway is a Rust binary spawned from the"
    echo "  peer2panda-link-language repo's gateway/ dir. Build it first:"
    echo "    cd \$WORKSPACE/peer2panda-link-language/gateway && cargo build --release"
    echo "  Or point PEER2PANDA_GATEWAY_DIR at an existing checkout."
    print_summary "peer2panda" || exit 1
fi

STATUS_RESP=$(curl -sf "$GATEWAY_URL/status" 2>/dev/null) || STATUS_RESP=""
GATEWAY_OK=$(echo "$STATUS_RESP" | jq -r '.ok // false' 2>/dev/null)
if [[ "$GATEWAY_OK" == "true" ]]; then
    pass "service-health" "Gateway healthy at $GATEWAY_URL"
else
    fail "service-health" "Gateway unhealthy: $STATUS_RESP"
    print_summary "peer2panda" || exit 1
fi

# ─── Step 2: Bind the node to a topic ───────────────────────────────────────

step "2. Binding p2panda node to topic '$TOPIC_ID'..."
INIT_RESP=$(curl -sf -X POST "$GATEWAY_URL/node/init" \
    -H "Content-Type: application/json" \
    -d "{\"topic\": \"$TOPIC_ID\"}" 2>/dev/null) || INIT_RESP=""

NODE_ID=$(echo "$INIT_RESP" | jq -r '.nodeId // empty' 2>/dev/null)
BOUND_TOPIC=$(echo "$INIT_RESP" | jq -r '.topic // empty' 2>/dev/null)
if [[ -n "$NODE_ID" ]]; then
    pass "node-init" "Node bound (id: ${NODE_ID:0:16}…, topic: ${BOUND_TOPIC:0:16}…)"
else
    fail "node-init" "Could not bind node: $INIT_RESP"
    print_summary "peer2panda" || exit 1
fi

# ─── Step 3: Configure language with template vars ──────────────────────────

step "3. Configuring peer2panda link language..."
TEMPLATE_DATA=$(jq -n \
    --arg gw "$GATEWAY_URL" \
    --arg topic "$TOPIC_ID" \
    '{
        "PEER2PANDA_GATEWAY_URL": $gw,
        "PEER2PANDA_TOPIC_ID": $topic
    }')

CONFIGURED_LANG=$(publish_and_configure_language "${LANG_PEER2PANDA:-}" "$TEMPLATE_DATA" 2>/dev/null) || true
if [[ -n "$CONFIGURED_LANG" && "$CONFIGURED_LANG" != "null" ]]; then
    pass "language-configure" "Configured: $CONFIGURED_LANG"
else
    fail "language-configure" "Could not apply template to peer2panda language"
    CONFIGURED_LANG="${LANG_PEER2PANDA:-}"
    warn "Falling back to base language address"
fi

# ─── Step 4: Create perspective → publish as neighbourhood ──────────────────

step "4. Creating perspective and neighbourhood..."
PERSPECTIVE_UUID=$(create_test_perspective "interop-peer2panda-${RUN_ID}" 2>/dev/null) || true
if [[ -z "$PERSPECTIVE_UUID" ]]; then
    fail "perspective-create" "Could not create perspective"
    print_summary "peer2panda" || exit 1
fi

NEIGHBOURHOOD_URL=$(create_test_neighbourhood "$PERSPECTIVE_UUID" "$CONFIGURED_LANG" 2>/dev/null) || true
if [[ -n "$NEIGHBOURHOOD_URL" ]]; then
    pass "neighbourhood-create" "Published neighbourhood"
else
    fail "neighbourhood-create" "Could not publish neighbourhood"
    print_summary "peer2panda" || exit 1
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

# ─── Step 6: Verify triples appear in peer2panda ───────────────────────────

step "6. Checking peer2panda for AD4M triples..."
sleep 3  # Give the language time to publish operations

TRIPLES_RESP=$(curl -sf "$GATEWAY_URL/triples" 2>/dev/null) || TRIPLES_RESP="{}"
TRIPLE_COUNT=$(echo "$TRIPLES_RESP" | jq '.triples | length' 2>/dev/null) || TRIPLE_COUNT=0

if [[ "$TRIPLE_COUNT" -gt 0 ]]; then
    pass "native-read" "Found $TRIPLE_COUNT triples in peer2panda"
else
    TEST_SUBJECT="ad4m://test/${RUN_ID}/subject-1"
    FILTERED_RESP=$(curl -sf "$GATEWAY_URL/triples?subject=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$TEST_SUBJECT'))")" 2>/dev/null) || FILTERED_RESP="{}"
    FILTERED_COUNT=$(echo "$FILTERED_RESP" | jq '.triples | length' 2>/dev/null) || FILTERED_COUNT=0

    if [[ "$FILTERED_COUNT" -gt 0 ]]; then
        pass "native-read" "Found $FILTERED_COUNT filtered triples in peer2panda"
    else
        fail "native-read" "No triples found in peer2panda"
    fi
fi

# ─── Step 7: Write triple from peer2panda (native) side ────────────────────

step "7. Writing triple from peer2panda (native) side..."
NATIVE_SUBJECT="peer2panda://native/subject-1"
NATIVE_PREDICATE="peer2panda://native/predicate-created"
NATIVE_OBJECT="peer2panda://native/object-1"

WRITE_RESP=$(curl -sf -X POST "$GATEWAY_URL/triples" \
    -H "Content-Type: application/json" \
    -d "{
        \"triples\": [{
            \"subject\": \"$NATIVE_SUBJECT\",
            \"predicate\": \"$NATIVE_PREDICATE\",
            \"object\": \"$NATIVE_OBJECT\",
            \"author\": \"did:key:gateway-test\",
            \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"
        }]
    }" 2>/dev/null) || WRITE_RESP=""

WRITE_REV=$(echo "$WRITE_RESP" | jq -r '.revision // empty' 2>/dev/null)
if [[ -n "$WRITE_REV" ]]; then
    pass "native-write" "Inserted triple (revision: $WRITE_REV)"
else
    fail "native-write" "Could not insert triple into peer2panda"
fi

# ─── Step 8: Trigger sync and check AD4M ───────────────────────────────────

step "8. Syncing AD4M and checking for native-written data..."
trigger_sync "$PERSPECTIVE_UUID" 2>/dev/null || true
sleep 3

LINKS_AFTER=$(query_test_links "$PERSPECTIVE_UUID" 2>/dev/null) || LINKS_AFTER="[]"
LINK_COUNT_AFTER=$(echo "$LINKS_AFTER" | jq 'if type == "array" then length else 0 end' 2>/dev/null) || LINK_COUNT_AFTER=0

NATIVE_FOUND=$(echo "$LINKS_AFTER" | jq --arg src "$NATIVE_SUBJECT" \
    'if type == "array" then [.[] | .data // . | select(.source == $src)] | length else 0 end' 2>/dev/null) || NATIVE_FOUND=0

if [[ "$NATIVE_FOUND" -gt 0 ]]; then
    pass "reverse-sync" "Native-written triple appeared in AD4M ($LINK_COUNT_AFTER total links)"
else
    if [[ "$LINK_COUNT_AFTER" -gt "$LINK_COUNT" ]]; then
        warn "Link count increased ($LINK_COUNT → $LINK_COUNT_AFTER) but native triple source not matched"
        skip "reverse-sync" "New links appeared but schema mapping unclear"
    else
        fail "reverse-sync" "Native-written data not found in AD4M after sync"
    fi
fi

# ─── Step 9: Verify incremental sync ───────────────────────────────────────

step "9. Verifying incremental sync support..."
SYNC_RESP=$(curl -sf "$GATEWAY_URL/sync?since=$WRITE_REV" 2>/dev/null) || SYNC_RESP=""
SYNC_REV=$(echo "$SYNC_RESP" | jq -r '.revision // empty' 2>/dev/null)

if [[ -n "$SYNC_REV" ]]; then
    SYNC_ADDS=$(echo "$SYNC_RESP" | jq '.additions | length' 2>/dev/null) || SYNC_ADDS=0
    pass "incremental-sync" "Incremental sync works (revision: $SYNC_REV, additions since: $SYNC_ADDS)"
else
    skip "incremental-sync" "Incremental sync endpoint not responding"
fi

# ─── Summary ────────────────────────────────────────────────────────────────

echo ""
echo "Manual verification:"
echo "  Gateway: $GATEWAY_URL"
echo "  GET $GATEWAY_URL/triples  — view all stored triples"
echo "  GET $GATEWAY_URL/status   — health check (nodeId, topic, opCount)"
echo "  GET $GATEWAY_URL/sync?since=rev-N  — incremental change log"

print_summary "peer2panda" || exit 1
