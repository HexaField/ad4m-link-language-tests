#!/usr/bin/env bash
# common.test.sh — regression tests for interop/common.sh output hygiene.
#
# The data-returning helpers (create_test_perspective, create_test_neighbourhood,
# publish_and_configure_language) are consumed via command substitution:
#
#     PERSPECTIVE_UUID=$(create_test_perspective "..." 2>/dev/null)
#
# so their stdout MUST contain only the returned value. If the diagnostic
# helpers (step/info/...) ever write to stdout again, the capture is polluted
# with progress lines and every downstream RPC receives a garbage multi-line
# identifier. This test stubs ad4m_rpc and asserts each helper's stdout is exactly
# the expected value — it fails loudly if diagnostics leak back onto stdout.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../common.sh
source "$SCRIPT_DIR/../common.sh"
set +e  # common.sh enables `set -e`; manage exit codes explicitly here.

# Stub the RPC layer so helpers run without a live executor.
ad4m_rpc() {
    case "$1" in
        perspective-create)      echo '{"uuid":"test-uuid-1234"}' ;;
        neighbourhood-publish)   echo '"neighbourhood://test-url"' ;;
        language-apply-template) echo '{"address":"QmTestTemplatedAddr"}' ;;
        *)                       echo '{}' ;;
    esac
}

FAILS=0
assert_stdout() {
    local label="$1" expected="$2" actual="$3"
    if [[ "$actual" == "$expected" ]]; then
        echo "  ✅ PASS: $label — clean stdout ('$actual')"
    else
        echo "  ❌ FAIL: $label"
        echo "     expected: '$expected'"
        echo "     actual:   '$actual'"
        FAILS=$((FAILS + 1))
    fi
}

echo "═══ common.sh output-hygiene regression tests ═══"

# Each capture mirrors how the verify-*.sh scripts consume these helpers.
uuid=$(create_test_perspective "regression" 2>/dev/null)
assert_stdout "create_test_perspective" "test-uuid-1234" "$uuid"

url=$(create_test_neighbourhood "test-uuid-1234" "QmLang" 2>/dev/null)
assert_stdout "create_test_neighbourhood" "neighbourhood://test-url" "$url"

addr=$(publish_and_configure_language "QmSource" '{}' 2>/dev/null)
assert_stdout "publish_and_configure_language" "QmTestTemplatedAddr" "$addr"

echo ""
if [[ "$FAILS" -gt 0 ]]; then
    echo "❌ $FAILS test(s) failed"
    exit 1
fi
echo "✅ All output-hygiene tests passed"
