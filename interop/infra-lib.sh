#!/usr/bin/env bash
# infra-lib.sh — self-contained, idempotent infra lifecycle for interop scripts.
#
# Each verify-<proto>.sh brings up EXACTLY the backend it needs and tears down
# EXACTLY what it started, without disturbing any pre-existing or system process.
#
# Public API:
#   infra_ensure <proto>   Bring up (or reuse) the backend for <proto>.
#                          Returns 0 when the backend is reachable (whether we
#                          started it or reused a pre-existing one), 1 on failure.
#   infra_teardown         Stop everything THIS process started. Idempotent and
#                          safe to call from an EXIT trap under `set -e`.
#
# Guarantees (this is the "idempotency to system processes" contract):
#   • Reuse-if-present. If the backend endpoint already answers, we ride it and
#     NEVER stop it — a relay/PDS/IPFS node the user runs for other purposes is
#     left exactly as found. Only backends we actually start get a teardown.
#   • Started-set teardown. Teardown is driven by an in-process record of what we
#     started, plus on-disk markers under $INFRA_STATE_DIR. A backend we reused is
#     never in either, so it is never torn down.
#   • File-scoped docker down. Teardown runs `docker compose -f <file> down`, which
#     only removes services defined in that one compose file — never a sibling
#     service that happens to share the compose project (e.g. a persistent IPFS
#     node named ad4m-test-ipfs-* is not touched when tearing down the relay).
#   • Process-group kill for gateways. A spawned gateway is killed by its own
#     process group (the pid we started), never `pkill -f gateway`, so a gateway
#     the user launched by hand survives.
#   • Crash recovery. On-disk markers let interop/teardown.sh reclaim infra a
#     hard-killed script leaked, and only that infra.
#
# Requires from common.sh: REPO_DIR, info/step/success/warn/error, curl. docker
# and nc are used when present. Every value is env-overridable.

INFRA_COMPOSE_DIR="${INFRA_COMPOSE_DIR:-$REPO_DIR/infra}"
# Compose project. Must match the name Docker Compose derives from the compose
# files' parent directory ("infra"), so that a stale container left by an earlier
# run — which carries com.docker.compose.project=infra — is recognised as ours and
# recreated on `up`, rather than colliding on its pinned container_name. up and
# down must use the SAME project to pair correctly.
INFRA_PROJECT="${INFRA_PROJECT:-infra}"
INFRA_STATE_DIR="${INFRA_STATE_DIR:-${TMPDIR:-/tmp}/ad4m-interop-state}"
INFRA_UP_TIMEOUT="${INFRA_UP_TIMEOUT:-120}"     # seconds to wait for a backend to go healthy
INFRA_HTTP_TIMEOUT="${INFRA_HTTP_TIMEOUT:-5}"
INFRA_TCP_TIMEOUT="${INFRA_TCP_TIMEOUT:-3}"
INFRA_KEEP="${INFRA_KEEP:-0}"                    # 1 = leave everything up on exit (debugging)

# In-process record of what THIS run started (drives the EXIT-trap teardown).
_INFRA_STARTED_DOCKER=()   # proto names
_INFRA_STARTED_PROC=()     # "proto|pid|logfile"

# ─── low-level probes ────────────────────────────────────────────────────────

_infra_http()      { curl -sf -m "$INFRA_HTTP_TIMEOUT" "$1" >/dev/null 2>&1; }
_infra_http_post() { curl -sf -m "$INFRA_HTTP_TIMEOUT" -X POST "$1" >/dev/null 2>&1; }
_infra_tcp() {
    local host="$1" port="$2"
    if command -v nc >/dev/null 2>&1; then
        nc -z -w"$INFRA_TCP_TIMEOUT" "$host" "$port" >/dev/null 2>&1
    else
        (exec 3<>"/dev/tcp/$host/$port") >/dev/null 2>&1
    fi
}

# Poll <cmd...> until it succeeds or <timeout>s elapse.
# Usage: _infra_wait <timeout> <cmd> [args...]
_infra_wait() {
    local timeout="$1"; shift
    local deadline=$(( SECONDS + timeout ))
    while (( SECONDS < deadline )); do
        if "$@"; then return 0; fi
        sleep 2
    done
    return 1
}

# ─── per-protocol descriptors ────────────────────────────────────────────────

# docker | proc | none. Protocols with no external infra (holochain, activitypub,
# git, expression-*) return "none" and infra_ensure is a no-op for them.
_infra_kind() {
    case "$1" in
        nostr|matrix|solid|atproto|ipfs) echo docker ;;
        hypercore|nextgraph|peer2panda)  echo proc ;;
        *)                               echo none ;;
    esac
}

_infra_docker_file() { echo "$INFRA_COMPOSE_DIR/docker-compose.$1.yml"; }

# Protocol-aware health probe — the reuse signal. Deliberately specific (an HTTP
# path or an API call), so we only ever "reuse" a real instance of the right
# backend, not an unrelated process that happens to hold the port.
_infra_health() {
    case "$1" in
        nostr)   _infra_tcp localhost "${NOSTR_PORT:-7777}" ;;
        matrix)  _infra_http "http://localhost:${CONDUIT_PORT:-6167}/_matrix/client/versions" ;;
        solid)   _infra_http "http://localhost:${SOLID_PORT:-3000}/" ;;
        atproto) _infra_http "http://localhost:${ATPROTO_PORT:-2583}/xrpc/_health" ;;
        ipfs)    _infra_http_post "http://localhost:${IPFS_API_PORT:-5001}/api/v0/id" ;;
        hypercore)  _infra_tcp localhost "${HYPERCORE_PORT:-7778}" ;;
        nextgraph)  _infra_tcp localhost "${NEXTGRAPH_PORT:-7779}" ;;
        peer2panda) _infra_tcp localhost "${PEER2PANDA_PORT:-7780}" ;;
        *) return 1 ;;
    esac
}

_infra_proc_port() {
    case "$1" in
        hypercore)  echo "${HYPERCORE_PORT:-7778}" ;;
        nextgraph)  echo "${NEXTGRAPH_PORT:-7779}" ;;
        peer2panda) echo "${PEER2PANDA_PORT:-7780}" ;;
        *) echo "" ;;
    esac
}

_infra_proc_dir() {
    local ws="${WORKSPACE:-$HOME/workspaces/coasys}"
    case "$1" in
        hypercore)  echo "${HYPERCORE_GATEWAY_DIR:-$ws/hypercore-link-language/gateway}" ;;
        nextgraph)  echo "${NEXTGRAPH_GATEWAY_DIR:-$ws/nextgraph-link-language/gateway}" ;;
        peer2panda) echo "${PEER2PANDA_GATEWAY_DIR:-$ws/peer2panda-link-language/gateway}" ;;
        *) echo "" ;;
    esac
}

# Echo the start command for a gateway, or return 1 if the gateway is not built
# (so the caller can skip cleanly rather than spawn a doomed process).
_infra_proc_cmd() {
    local proto="$1" dir; dir="$(_infra_proc_dir "$proto")"
    case "$proto" in
        hypercore|nextgraph)
            [[ -d "$dir/node_modules" ]] || return 1
            echo "npm start" ;;
        peer2panda)
            local bin="$dir/target/release/peer2panda-gateway"
            [[ -x "$bin" ]] || return 1
            echo "$bin" ;;
        *) return 1 ;;
    esac
}

# ─── bring-up ────────────────────────────────────────────────────────────────

infra_ensure() {
    local proto="$1"
    case "$(_infra_kind "$proto")" in
        none)   return 0 ;;
        docker) _infra_ensure_docker "$proto" ;;
        proc)   _infra_ensure_proc "$proto" ;;
        *)      error "infra: unknown protocol '$proto'"; return 1 ;;
    esac
}

_infra_ensure_docker() {
    local proto="$1" file
    file="$(_infra_docker_file "$proto")"
    if [[ ! -f "$file" ]]; then
        info "infra: no compose file for $proto ($file) — nothing to start"
        return 0
    fi
    if _infra_health "$proto"; then
        success "infra: $proto backend already reachable — reusing (left untouched on exit)"
        return 0
    fi
    if ! command -v docker >/dev/null 2>&1; then
        error "infra: docker not found — cannot start $proto backend"
        return 1
    fi
    step "infra: starting $proto backend (docker compose)…"
    if ! docker compose -p "$INFRA_PROJECT" -f "$file" up -d >/dev/null 2>&1; then
        error "infra: 'docker compose up' failed for $proto — a non-$proto process may hold the port"
        return 1
    fi
    _INFRA_STARTED_DOCKER+=("$proto")
    mkdir -p "$INFRA_STATE_DIR" 2>/dev/null || true
    echo "$file" > "$INFRA_STATE_DIR/docker-$proto" 2>/dev/null || true
    if _infra_wait "$INFRA_UP_TIMEOUT" _infra_health "$proto"; then
        success "infra: $proto backend up"
        return 0
    fi
    error "infra: $proto backend did not become healthy within ${INFRA_UP_TIMEOUT}s"
    return 1
}

_infra_ensure_proc() {
    local proto="$1" port dir cmd log pid
    port="$(_infra_proc_port "$proto")"
    if _infra_tcp localhost "$port"; then
        success "infra: $proto gateway already serving :$port — reusing (left untouched on exit)"
        return 0
    fi
    dir="$(_infra_proc_dir "$proto")"
    if [[ ! -d "$dir" ]]; then
        warn "infra: $proto gateway dir not found ($dir) — cannot self-provision"
        return 1
    fi
    if ! cmd="$(_infra_proc_cmd "$proto")"; then
        warn "infra: $proto gateway not built in $dir — build it first, then re-run"
        return 1
    fi
    mkdir -p "$INFRA_STATE_DIR" 2>/dev/null || true
    log="$(mktemp "${TMPDIR:-/tmp}/ad4m-interop-${proto}-XXXXXX.log")"
    step "infra: starting $proto gateway on :$port…"
    # setsid → the child leads its own process group, so teardown can SIGTERM the
    # whole group (npm → node children) by killing -$pid, and only that group.
    setsid bash -c "cd '$dir' && exec env PORT='$port' $cmd" >"$log" 2>&1 &
    pid=$!
    _INFRA_STARTED_PROC+=("$proto|$pid|$log")
    echo "$pid|$log" > "$INFRA_STATE_DIR/proc-$proto" 2>/dev/null || true
    if _infra_wait 60 _infra_tcp localhost "$port"; then
        success "infra: $proto gateway up (pid $pid)"
        return 0
    fi
    error "infra: $proto gateway did not open :$port within 60s — see $log"
    return 1
}

# ─── teardown ────────────────────────────────────────────────────────────────

infra_teardown() {
    if [[ "$INFRA_KEEP" == "1" ]]; then
        warn "infra: INFRA_KEEP=1 — leaving started infra running"
        return 0
    fi
    _infra_teardown_proc
    _infra_teardown_docker
}

_infra_teardown_docker() {
    local proto file
    for proto in "${_INFRA_STARTED_DOCKER[@]:-}"; do
        [[ -z "$proto" ]] && continue
        file="$(_infra_docker_file "$proto")"
        step "infra: stopping $proto backend…"
        docker compose -p "$INFRA_PROJECT" -f "$file" down -v >/dev/null 2>&1 || true
        rm -f "$INFRA_STATE_DIR/docker-$proto" 2>/dev/null || true
    done
    _INFRA_STARTED_DOCKER=()
}

_infra_teardown_proc() {
    local entry proto pid log
    for entry in "${_INFRA_STARTED_PROC[@]:-}"; do
        [[ -z "$entry" ]] && continue
        IFS='|' read -r proto pid log <<<"$entry"
        _infra_kill_group "$proto" "$pid"
        [[ -n "${log:-}" ]] && rm -f "$log" 2>/dev/null || true
        rm -f "$INFRA_STATE_DIR/proc-$proto" 2>/dev/null || true
    done
    _INFRA_STARTED_PROC=()
}

# SIGTERM then SIGKILL a process group by its leader pid. Only ever the pid we
# spawned — never a pattern match against a user's own gateway.
_infra_kill_group() {
    local proto="$1" pid="$2"
    [[ -z "$pid" ]] && return 0
    kill -0 "$pid" 2>/dev/null || return 0
    step "infra: stopping $proto gateway (pid $pid)…"
    kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    local i
    for i in 1 2 3 4 5 6; do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
}

# ─── safety net (used by teardown.sh) ────────────────────────────────────────

# Reclaim any infra leaked by a hard-killed run — and ONLY that infra, via the
# on-disk markers. Backends that were reused (never marked) are never touched.
infra_teardown_markers() {
    local marker proto file entry pid log
    [[ -d "$INFRA_STATE_DIR" ]] || { info "infra: no leaked infra markers"; return 0; }
    for marker in "$INFRA_STATE_DIR"/docker-*; do
        [[ -e "$marker" ]] || continue
        proto="$(basename "$marker" | sed 's/^docker-//')"
        file="$(cat "$marker" 2>/dev/null)"
        [[ -f "$file" ]] || file="$(_infra_docker_file "$proto")"
        step "infra: reclaiming leaked $proto backend…"
        docker compose -p "$INFRA_PROJECT" -f "$file" down -v >/dev/null 2>&1 || true
        rm -f "$marker" 2>/dev/null || true
    done
    for marker in "$INFRA_STATE_DIR"/proc-*; do
        [[ -e "$marker" ]] || continue
        proto="$(basename "$marker" | sed 's/^proc-//')"
        entry="$(cat "$marker" 2>/dev/null)"
        IFS='|' read -r pid log <<<"$entry"
        _infra_kill_group "$proto" "$pid"
        [[ -n "${log:-}" ]] && rm -f "$log" 2>/dev/null || true
        rm -f "$marker" 2>/dev/null || true
    done
}
