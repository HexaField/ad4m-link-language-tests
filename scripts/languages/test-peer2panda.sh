#!/usr/bin/env bash
# test-peer2panda.sh — peer2panda Link Language integration test
# Infrastructure: peer2panda sidecar gateway (Rust + p2panda v0.7, NOT Docker)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../common.sh
source "$SCRIPT_DIR/../common.sh"
load_config

GATEWAY_PID=""
GATEWAY_PORT="${PEER2PANDA_PORT:-7780}"
GATEWAY_URL="http://${DEVICE_A_HOST:-127.0.0.1}:${GATEWAY_PORT}"
GATEWAY_DIR="${PEER2PANDA_GATEWAY_DIR:-}"

setup_peer2panda_infra() {
    echo "  Setting up peer2panda gateway..."

    # Find the gateway directory (the Rust sidecar lives in the language repo)
    if [[ -z "$GATEWAY_DIR" ]]; then
        for dir in \
            "$REPO_DIR/../peer2panda-link-language/gateway" \
            "/tmp/peer2panda-link-language/gateway" \
            "${WORKSPACE:-$HOME/workspaces}/peer2panda-link-language/gateway" \
            "${WORKSPACE:-$HOME/workspaces}/coasys/peer2panda-link-language/gateway"; do
            if [[ -d "$dir" ]]; then
                GATEWAY_DIR="$dir"
                break
            fi
        done
    fi

    if [[ -z "$GATEWAY_DIR" || ! -d "$GATEWAY_DIR" ]]; then
        echo "  ERROR: peer2panda gateway directory not found"
        echo "  Set PEER2PANDA_GATEWAY_DIR or clone peer2panda-link-language"
        return 1
    fi

    # Locate cargo (may live in ~/.cargo/bin outside the login PATH)
    local cargo_bin="cargo"
    if ! command -v cargo &>/dev/null; then
        if [[ -x "$HOME/.cargo/bin/cargo" ]]; then
            cargo_bin="$HOME/.cargo/bin/cargo"
        else
            echo "  ERROR: cargo not found — install Rust to build the gateway"
            return 1
        fi
    fi

    # Build the release binary if it isn't already present
    local gateway_bin="$GATEWAY_DIR/target/release/peer2panda-gateway"
    if [[ ! -x "$gateway_bin" ]]; then
        echo "  Building peer2panda gateway (cargo build --release)..."
        (cd "$GATEWAY_DIR" && "$cargo_bin" build --release) || {
            echo "  ERROR: gateway build failed"
            return 1
        }
    fi

    # Start the gateway (in-memory operation store — ephemeral per test run)
    echo "  Starting peer2panda gateway on port $GATEWAY_PORT..."
    PORT="$GATEWAY_PORT" DATABASE_URL="sqlite::memory:" \
        "$gateway_bin" &>/tmp/peer2panda-gateway.log &
    GATEWAY_PID=$!

    # Wait for the gateway to answer /status
    local tries=0
    while ! curl -sf "$GATEWAY_URL/status" >/dev/null 2>&1; do
        sleep 1
        tries=$((tries + 1))
        if [[ $tries -ge 30 ]]; then
            echo "  ERROR: Gateway did not start within 30s"
            echo "  Logs:"
            tail -20 /tmp/peer2panda-gateway.log
            return 1
        fi
    done
    echo "  peer2panda gateway ready at $GATEWAY_URL"
}

teardown_peer2panda_infra() {
    echo "  Tearing down peer2panda gateway..."
    if [[ -n "$GATEWAY_PID" ]]; then
        kill "$GATEWAY_PID" 2>/dev/null || true
        wait "$GATEWAY_PID" 2>/dev/null || true
    fi
}

run_standard_tests "peer2panda" "${LANG_PEER2PANDA:-}" setup_peer2panda_infra teardown_peer2panda_infra
