# AD4M Link Language Interop Tests

**Bidirectional data flow verification between AD4M/Flux and native protocol apps.**

Each test proves that AD4M link languages can:
1. **Write** links via AD4M → data appears in the native protocol's storage
2. **Read** data written by native protocol apps → links appear in AD4M

## Quick Start

Each `verify-*.sh` is **self-contained**: it brings up exactly the backend it
needs, then tears down exactly what it started when it exits. You do not need to
start anything by hand first.

```bash
# Run one test — it provisions its own backend and cleans up after itself
./verify-nostr.sh

# Run all of them
for f in verify-*.sh; do ./$f; echo ""; done
```

`setup.sh` and `teardown.sh` are **optional**:

```bash
# OPTIONAL: pre-warm every backend once so a batch run reuses them instead of
# spinning each up/down per script (a speed optimisation for the loop above).
./setup.sh

# OPTIONAL safety net: reclaim any backend a hard-killed script leaked. Only
# touches infra started by these scripts (tracked via on-disk markers); reused
# and system services are left alone.
./teardown.sh
```

## Prerequisites

Everything runs wherever you invoke the scripts — against a local AD4M executor
and local backends. There is no remote runner and no SSH.

- **Python 3** with `websockets` (`pip3 install websockets`) — WS-RPC client
- **jq**, **curl**, **nc** (netcat)
- **Docker** + **Docker Compose v2** — for the docker-backed protocols
- **Node.js** — for the Node sidecar gateways (Hypercore, NextGraph)
- **Rust** (cargo) — for the peer2panda sidecar gateway
- **Go** — for the Anytype sidecar gateway (any-sync)
- An **AD4M executor** running on `ws://127.0.0.1:12000` (admin token `test123`),
  with the link languages under test installed. The executor is the
  system-under-test — it is provisioned externally, not by these scripts.

Ports used by the self-provisioned backends (each script only touches its own):

| Port | Backend            | Port | Backend                |
|------|--------------------|------|------------------------|
| 12000| AD4M executor      | 5001 | IPFS (Kubo API)        |
| 6167 | Matrix (Conduit)   | 7777 | Nostr relay            |
| 2583 | AT Proto (PDS)     | 7778 | Hypercore gateway      |
| 3000 | Solid (CSS)        | 7779 | NextGraph gateway      |
|      |                    | 7780 | peer2panda gateway     |
|      |                    | 7794 | Anytype gateway        |

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  verify-<proto>.sh                                               │
│                                                                  │
│   source common.sh ─► infra-lib.sh                              │
│        │                    │                                    │
│        │   infra_ensure <proto>   (reuse-if-healthy, else start)│
│        ▼                    ▼                                    │
│   ┌─────────┐   WS :12000   ┌──────────────────────────────┐   │
│   │  AD4M   │◄─────────────►│  backend for <proto>          │   │
│   │executor │               │  docker compose  OR  gateway  │   │
│   └─────────┘               └──────────────────────────────┘   │
│        │                    ▲                                    │
│        │   infra_teardown   │ (on EXIT — stops only what we    │
│        └────────────────────┘  started; reused infra untouched)│
└────────────────────────────────────────────────────────────────┘
```

### Self-contained infra lifecycle

The lifecycle is implemented once in **`infra-lib.sh`** (sourced by `common.sh`)
and exposed as two functions every verify script uses:

- **`infra_ensure <proto>`** — make the backend reachable. If it already answers
  its health probe, the script **reuses** it and records nothing. Otherwise the
  script starts it (`docker compose -p infra -f <repo-root>/infra/docker-compose.<proto>.yml up -d`
  for docker backends, or the repo's `gateway/` process for sidecars) and records
  what it started. Override the compose dir with `$INFRA_COMPOSE_DIR`.
- **`infra_teardown`** — called from each script's `EXIT` trap. Stops **only what
  this run started**, then removes its markers.

**Idempotency to system processes** is the core guarantee:

- **Reuse-if-present.** A relay / PDS / IPFS node you run for other purposes
  answers the health probe, so it is reused and never stopped.
- **Started-set teardown.** Teardown is driven by an in-process record plus
  on-disk markers under `$INFRA_STATE_DIR`. Anything reused is in neither, so it
  is never torn down.
- **File-scoped `docker compose down`.** Teardown only removes services defined
  in that one compose file — a persistent sibling (e.g. an `ad4m-test-ipfs-*`
  node) sharing the compose project is left running.
- **Process-group kill for gateways.** A spawned gateway is killed by the exact
  pid/process-group we started, never a `pkill -f` pattern that could match a
  gateway you launched by hand.
- **Crash recovery.** If a script is hard-killed before its trap runs, `./teardown.sh`
  reclaims the leak from the markers — and only that leak.

Protocols with no external infra (ActivityPub, git, expression-*, Holochain) are
self-contained in the executor; `infra_ensure` is a no-op for them.

## Test Flow (each verify-*.sh)

Every verification script follows the same 10-step pattern:

| Step | What                                      | How                                        |
|------|-------------------------------------------|--------------------------------------------|
| 1    | Health check                              | HTTP/WS probe to the backend service       |
| 2    | Test user/account setup                   | Create or login via native protocol API    |
| 3    | Apply language template                   | `language.applyTemplate` with service URLs |
| 4    | Create perspective → neighbourhood        | AD4M RPC to create perspective + publish   |
| 5    | Add 3 test links via AD4M                 | `perspective.addLink` × 3                  |
| 6    | Query links in AD4M                       | `perspective.queryLinks`                   |
| 7    | Query native service                      | Protocol-specific API call                 |
| 8    | Write data from native side               | Protocol-specific write                    |
| 9    | Trigger AD4M sync                         | `perspective.pullLinks`                    |
| 10   | Verify native data in AD4M                | `perspective.queryLinks` + check           |

## Protocol Details

### Matrix (Conduit)

| Item            | Value                                      |
|-----------------|--------------------------------------------|
| Service         | Conduit (lightweight Matrix homeserver)     |
| Container       | `ad4m-test-matrix-conduit`                  |
| Port            | 6167                                        |
| Language        | `QmzSYwdkxzhf4sCxuUH28xY6qCFb4xtEPxf4tSSrz8KNs3WUzAW` |
| Event type      | `dev.ad4m.link.triple` (custom room event) |
| Native app      | [Element Web](https://app.element.io) with custom homeserver |

**Interop proof:** AD4M writes links → custom events appear in Matrix room timeline → Element shows them. Custom event written via Matrix API → AD4M sync picks it up.

### AT Protocol (PDS)

| Item            | Value                                      |
|-----------------|--------------------------------------------|
| Service         | Bluesky PDS (Personal Data Server)         |
| Container       | `ad4m-test-atproto-pds`                     |
| Port            | 2583                                        |
| Language        | `QmzSYwdgzU4pEnJUebu7yrZucqRGSaTfKJs7NBMuFcZLL28xqEq` |
| Collection      | `app.ad4m.link`                             |
| Native app      | curl to XRPC endpoints                     |

**Interop proof:** AD4M writes links → records appear in PDS repo under `app.ad4m.link` collection → `com.atproto.repo.listRecords` shows them. Record created via XRPC → AD4M sync picks it up.

> **Note:** Self-hosted PDS may reject custom Lexicons. The `app.ad4m.link` collection type may need to be registered with the PDS. See [AT Protocol Lexicon docs](https://atproto.com/specs/lexicon).

### Solid (CSS)

| Item            | Value                                      |
|-----------------|--------------------------------------------|
| Service         | Community Solid Server                     |
| Container       | `ad4m-test-solid-server`                    |
| Port            | 3000                                        |
| Language        | `QmzSYwdq6o6am1uXnDU7BJ9GFxVFs5xUJLqFQd3ewar7NvSFi8f` |
| Data format     | RDF/Turtle in LDP containers               |
| Native app      | [Penny](https://penny.vincenttunru.com/) or Mashlib |

**Interop proof:** AD4M writes links → Turtle resources appear in Solid pod container → browse in Penny. Turtle resource PUT to pod → AD4M sync picks it up.

### IPFS (Kubo)

| Item            | Value                                      |
|-----------------|--------------------------------------------|
| Service         | Kubo (go-ipfs)                             |
| Container       | `ad4m-test-ipfs-a`, `ad4m-test-ipfs-b`     |
| Ports           | 5001 (node A API), 5002 (node B API)       |
| Language        | `QmzSYwdiVKeuFLdJSLNndi4Gpjegp1DATGrfyCphXxYYHd4gfRf` |
| Data format     | DAG-JSON objects                            |
| Native app      | IPFS Gateway or IPFS Desktop               |

**Interop proof:** AD4M writes links → DAG-JSON published to IPFS, fetchable via CID at gateway. DAG-JSON object added via API → AD4M reads CID.

### Nostr

| Item            | Value                                      |
|-----------------|--------------------------------------------|
| Service         | nostr-rs-relay                             |
| Container       | `ad4m-test-nostr-relay`                     |
| Port            | 7777 (WebSocket)                           |
| Language        | `QmzSYwdoGhjYy5u7kQwRtv9GZy9U6y66GrdCWaEfk7zQDM3yMsW` |
| Event kind      | 30078 (parameterized replaceable — app data)|
| Native app      | [Snort](https://snort.social), [Iris](https://iris.to) |

**Interop proof:** AD4M writes links → kind:30078 events appear on relay → Nostr client shows app data. Event published via WebSocket → AD4M sync picks it up.

The Nostr language uses native Deno WebSocket connections to relays (not `httpFetch`) and BIP-340 Schnorr signing via `@noble/curves`.

### NextGraph

| Item            | Value                                      |
|-----------------|--------------------------------------------||
| Service         | Custom Node.js gateway (NOT Docker)        |
| Port            | 7779                                        |
| Language        | (pending — alpha)                          |
| Data format     | RDF Triples (SPARQL)                       |
| Native app      | NextGraph apps                             |

**Interop proof:** AD4M writes links → SPARQL triples stored in NextGraph wallet/store, queryable via gateway API. Triples written via gateway → AD4M sync picks them up.

The NextGraph language communicates with a sidecar gateway via `httpFetch`. The gateway wraps the `@ng-org/nextgraph` WASM SDK, handling wallet management, SPARQL operations, and CRDT-based synchronization. This follows the same sidecar pattern as Hypercore.

### Hypercore

| Item            | Value                                      |
|-----------------|--------------------------------------------|
| Service         | Custom Node.js gateway (NOT Docker)        |
| Port            | 7778                                        |
| Language        | `QmzSYwdpq92UgzvHHBAsHTC6jRHkBf7y74DaLmrAWnb8XUtnMVH` |
| Data format     | JSON entries in Hypercore feed             |
| Native app      | `hyp` CLI or custom Hypercore scripts      |

**Interop proof:** AD4M writes links → entries appended to Hypercore feed, visible via gateway API. Entry appended via gateway → AD4M sync picks it up.

The Hypercore language communicates with the sidecar gateway via `httpFetch`. The gateway handles Hyperswarm peer discovery and Corestore feed management.

### Anytype (any-sync)

| Item            | Value                                      |
|-----------------|--------------------------------------------|
| Service         | Custom Go gateway embedding any-sync (NOT Docker) |
| Port            | 7794                                        |
| Language        | *(pending publish — anytype-link-language)* |
| Data format     | any-sync `objecttree` TreeChange (native change-DAG) |
| Native app      | Anytype desktop (render needs `anytype-heart`) |

**Interop proof:** AD4M writes links → one Ed25519-signed `TreeChange` per diff is appended to the space's object tree, foldable via the gateway `/links` and `/sync`. A second identity (distinct DID) joins the same `AnyoneCanJoin` space and appends a native diff → AD4M sync picks it up — convergence over the shared object tree, not a shim.

The Anytype language communicates with a sidecar gateway via `httpFetch`. The gateway embeds the `any-sync` Go stack (`objecttree` / `commonspace` / ACL) and folds an OR-Set keyed by link hash; two agents behind one gateway are two separate any-sync clients routed by the `X-Ad4m-Did` header. This follows the same sidecar pattern as Hypercore and NextGraph. The gateway depends only on `any-sync` (MIT) + `any-store`; `anytype-heart` is **not** vendored (ASAL 1.0), so native-client render is out of scope.

## Docker Compose

Each docker-backed protocol has its **own** compose file in the **repo-root
`infra/`** directory (i.e. `../infra/` from here), one service per file. The
verify scripts never call these directly — `infra_ensure` does, via an absolute
path — but you can drive them by hand for debugging:

```bash
# Start one backend (file-scoped — the same project the scripts use)
docker compose -p infra -f ../infra/docker-compose.nostr.yml up -d

# Logs / status
docker compose -p infra -f ../infra/docker-compose.nostr.yml logs -f
docker compose -p infra -f ../infra/docker-compose.nostr.yml ps

# Stop and remove (only this file's service; siblings untouched)
docker compose -p infra -f ../infra/docker-compose.nostr.yml down -v
```

| File                            | Protocol    | Container(s)                         | Port(s)      |
|---------------------------------|-------------|-------------------------------------|--------------|
| `docker-compose.nostr.yml`      | Nostr       | `ad4m-test-nostr-relay`             | 7777         |
| `docker-compose.matrix.yml`     | Matrix      | `ad4m-test-matrix-conduit`          | 6167         |
| `docker-compose.solid.yml`      | Solid       | `ad4m-test-solid-server`            | 3000         |
| `docker-compose.atproto.yml`    | AT Protocol | `ad4m-test-atproto-pds`             | 2583         |
| `docker-compose.ipfs.yml`       | IPFS        | `ad4m-test-ipfs-a`, `ad4m-test-ipfs-b` | 5001, 5002 |

> The `-p infra` project name matters: it must match the name Compose derives
> from the `infra/` directory, so a stale container from an earlier run is
> recognised and recreated rather than colliding on its pinned `container_name`.

## Sidecar Gateways

Hypercore, NextGraph, peer2panda, and Anytype are not Docker — they are sidecar
processes spawned from each link-language repo's `gateway/` dir. `infra_ensure`
starts them if the port is free, or reuses one you already have running. It will
**not** try to build them; if the gateway isn't built, the verify script skips
with a build hint. Build ahead of time with:

```bash
# Node gateways (Hypercore, NextGraph)
cd $WORKSPACE/hypercore-link-language/gateway && npm install
cd $WORKSPACE/nextgraph-link-language/gateway && npm install

# peer2panda (Rust binary)
cd $WORKSPACE/peer2panda-link-language/gateway && cargo build --release

# Anytype (Go binary embedding any-sync)
cd $WORKSPACE/anytype-link-language/gateway && go build -o anytype-gateway .
```

Override a gateway's location with `HYPERCORE_GATEWAY_DIR` / `NEXTGRAPH_GATEWAY_DIR`
/ `PEER2PANDA_GATEWAY_DIR` / `ANYTYPE_GATEWAY_DIR` if your checkout lives elsewhere.

## Configuration

All scripts use defaults defined in `common.sh` / `infra-lib.sh`:

| Variable          | Default              | Description                                  |
|-------------------|----------------------|----------------------------------------------|
| `AD4M_HOST`       | `127.0.0.1`          | Executor host                                |
| `AD4M_PORT`       | `12000`              | Executor port                                |
| `AD4M_TOKEN`      | `test123`            | Executor admin token                         |
| `INFRA_STATE_DIR` | `$TMPDIR/ad4m-interop-state` | Where started-infra markers are written |
| `INFRA_UP_TIMEOUT`| `120`                | Seconds to wait for a backend to go healthy  |
| `INFRA_KEEP`      | `0`                  | `1` = leave started infra running on exit (debug) |

Override via environment variables:
```bash
AD4M_HOST=10.0.0.100 AD4M_PORT=4000 ./verify-matrix.sh

# Keep the backend up after the test to poke at it by hand
INFRA_KEEP=1 ./verify-nostr.sh
```

## WS RPC Protocol

The AD4M executor uses WebSocket RPC at `ws://host:12000/api/v1/ws?token=<TOKEN>`.

Wire format:
```json
// Request
{"id": "abc123", "type": "operation.name", "params": {...}}

// Response  
{"id": "abc123", "result": ...}
```

Key operations used by these tests:
- `language.applyTemplate` — configure a language with service-specific params
- `perspective.create` — create a new perspective
- `neighbourhood.publish` — publish perspective as neighbourhood with link language
- `perspective.addLink` — add a link triple
- `perspective.queryLinks` — query links
- `perspective.pullLinks` — trigger sync
- `perspective.remove` — cleanup

The `ad4m-rpc.py` script wraps all operations as CLI commands.

## Troubleshooting

### Service not reachable
```bash
# What's running (and what these scripts started)
docker ps --filter 'name=ad4m-test'
docker logs ad4m-test-matrix-conduit
ss -tlnp | grep 6167

# What infra a run left tracked (markers). If a script was hard-killed, reclaim
# the leak — and only the leak — with ./teardown.sh.
ls -l "${INFRA_STATE_DIR:-${TMPDIR:-/tmp}/ad4m-interop-state}"
```

### Executor not responding
```bash
# Test the WebSocket-RPC directly
python3 -c "
import asyncio, websockets, json
async def test():
    async with websockets.connect('ws://127.0.0.1:12000/api/v1/ws?token=test123') as ws:
        await ws.send(json.dumps({'id':'1','type':'agent.status','params':{}}))
        print(await ws.recv())
asyncio.run(test())
"
```

### Language template fails
The language may not support the template parameters being passed. Check:
```bash
python3 ../scripts/ad4m-rpc.py --host 127.0.0.1 --port 12000 --token test123 \
    language-get <LANGUAGE_ADDRESS>
```

### A backend won't start
`infra_ensure` reuses anything already answering the health probe, so a "port in
use" is normally reused, not an error. If a start genuinely fails:
1. A **non-matching** process holds the port (something other than the expected
   backend). Free the port, or point the script at the real service via the
   protocol's `*_PORT` env var.
2. A **stale exited** container blocks recreation — ensure you use `-p infra`
   (the scripts do); mismatched project names cause `container_name` conflicts.
3. A **sidecar gateway isn't built** — build it (see *Sidecar Gateways* above).

## File Structure

```
ad4m-wind-tunnel/
├── infra/                    # Repo-root: one compose file per docker-backed protocol
│   ├── docker-compose.nostr.yml
│   ├── docker-compose.matrix.yml
│   ├── docker-compose.solid.yml
│   ├── docker-compose.atproto.yml
│   └── docker-compose.ipfs.yml   # two nodes: ad4m-test-ipfs-a/-b
└── interop/
    ├── README.md             # This file
    ├── common.sh             # Shared helpers: RPC, colours, assertions; sources infra-lib.sh
    ├── infra-lib.sh          # Self-contained infra lifecycle: infra_ensure / infra_teardown
    ├── infra/
    │   └── conduit.toml      # Matrix homeserver config (NOT the compose files)
    ├── setup.sh              # OPTIONAL pre-warm every backend for batch runs
    ├── teardown.sh           # OPTIONAL marker-driven safety net for leaked infra
    ├── verify-matrix.sh      # Matrix ↔ AD4M           (docker)
    ├── verify-atproto.sh     # AT Protocol ↔ AD4M      (docker)
    ├── verify-solid.sh       # Solid ↔ AD4M            (docker)
    ├── verify-ipfs.sh        # IPFS ↔ AD4M             (docker)
    ├── verify-nostr.sh       # Nostr ↔ AD4M            (docker)
    ├── verify-hypercore.sh   # Hypercore ↔ AD4M        (sidecar gateway)
    ├── verify-nextgraph.sh   # NextGraph ↔ AD4M        (sidecar gateway)
    ├── verify-peer2panda.sh  # peer2panda ↔ AD4M       (sidecar gateway)
    ├── verify-anytype.sh     # Anytype (any-sync) ↔ AD4M (sidecar gateway)
    ├── verify-activitypub.sh # ActivityPub ↔ AD4M      (no external infra)
    ├── verify-git.sh         # git ↔ AD4M              (no external infra)
    └── verify-expression-*.sh # expression-language checks (no external infra)
```

Each `verify-*.sh` sources `common.sh` (which sources `infra-lib.sh`), then calls
`infra_ensure <proto>` at the top and `infra_teardown` from its `EXIT` trap. The
docker compose files live at the **repo-root `infra/`** (`$INFRA_COMPOSE_DIR`),
which is distinct from `interop/infra/` (Matrix config only).

## Language Repos

| Protocol | Repo | Verify Script |
|----------|------|---------------|
| Matrix | [matrix-link-language](https://github.com/HexaField/matrix-link-language) | `verify-matrix.sh` |
| Nostr | [nostr-link-language](https://github.com/HexaField/nostr-link-language) | `verify-nostr.sh` |
| AT Protocol | [atproto-link-language](https://github.com/HexaField/atproto-link-language) | `verify-atproto.sh` |
| IPFS | [ipfs-link-language](https://github.com/HexaField/ipfs-link-language) | `verify-ipfs.sh` |
| Solid | [solid-link-language](https://github.com/HexaField/solid-link-language) | `verify-solid.sh` |
| Hypercore | [hypercore-link-language](https://github.com/HexaField/hypercore-link-language) | `verify-hypercore.sh` |
| ActivityPub | [ap-link-language](https://github.com/HexaField/ap-link-language) | `verify-activitypub.sh` |
| NextGraph | [nextgraph-link-language](https://github.com/HexaField/nextgraph-link-language) | `verify-nextgraph.sh` |
| Anytype | anytype-link-language *(pending publish)* | `verify-anytype.sh` |
| Holochain | [ad4m/bootstrap-languages/p-diff-sync](https://github.com/coasys/ad4m/tree/dev/bootstrap-languages/p-diff-sync) | (multi-device only) |

New language? Start from the [ad4m-link-language-template](https://github.com/HexaField/ad4m-link-language-template).

## Related

- Top-level README: [`../README.md`](../README.md) — overview, basic usage, architecture
- Multi-device sync tests: `../scripts/` — two-executor bidirectional sync
- RPC client: `../scripts/ad4m-rpc.py` — WebSocket RPC wrapper
