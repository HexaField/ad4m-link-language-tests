# Infrastructure Requirements

This document describes the external infrastructure needed for each Link Language protocol under test. Some protocols are fully P2P and need nothing; others require relay servers, homeservers, or daemon processes.

> **You usually don't provision any of this by hand.** Each `interop/verify-<proto>.sh`
> is self-contained: it brings up exactly the backend it needs and tears down
> exactly what it started on exit, reusing anything already running and never
> touching a system process. This document is the reference for *what* each
> backend is and *how it's wired* — see `interop/README.md` for the lifecycle
> (`infra-lib.sh` → `infra_ensure` / `infra_teardown`) and its
> idempotency-to-system-processes contract.

## Overview

| Protocol | Infrastructure | Self-Hosted | Public Option | Cost |
|---|---|---|---|---|
| Holochain | None | — | Public bootstrap/signal | Free |
| ActivityPub | None | — | Built into executor | Free |
| git | None (uses a git remote) | — | GitHub / Radicle | Free |
| AT Protocol | PDS server | ✅ Docker | bsky.social | Minimal |
| Nostr | Relay | ✅ Docker | Public relays | Minimal |
| Matrix | Homeserver | ✅ Docker | matrix.org | Minimal |
| Solid | Pod server | ✅ Docker | solidcommunity.net | Minimal |
| IPFS | kubo daemon | ✅ Docker | Public gateways | Minimal |
| Hypercore | Sidecar gateway | ✅ Node.js | — | Minimal |
| NextGraph | Sidecar gateway | ✅ Node.js | — | Minimal |
| peer2panda | Sidecar gateway | ✅ Rust binary | — | Minimal |

---

## Holochain

### What's Needed
**Nothing.** Holochain uses public bootstrap and signal servers operated by the Holochain Foundation. Peers discover each other via a distributed hash table (DHT).

### Network Requirements
- **Outbound internet** on both machines (for bootstrap/signal server connections)
- **UDP/TCP** to public Holochain infrastructure
- No specific ports need to be opened inbound

### Persistence
Data is stored locally in the conductor's database. If a machine goes offline, its data persists locally and will re-sync when it reconnects to the DHT.

### Notes
- Initial peer discovery may take 10-30 seconds
- Consider increasing `SYNC_WAIT_SECONDS` for Holochain tests
- No Docker infrastructure needed

---

## ActivityPub

### What's Needed
**Nothing external.** The AD4M executor includes a built-in ActivityPub server. Both executors federate directly with each other.

### Network Requirements
- **Both executor ports must be reachable** from each other (bidirectional HTTP)
- If behind NAT, both machines need port forwarding or a shared network (LAN/Tailscale)
- Protocol: HTTP (TCP)

### Persistence
ActivityPub data is stored in the executor's data directory. Federation ensures both sides have copies.

### Notes
- The simplest protocol to test — no external dependencies
- Sync speed depends on executor-to-executor HTTP latency

---

## AT Protocol

### What's Needed
A **Personal Data Server (PDS)** — the storage backend for AT Protocol accounts and data.

### Self-Hosted (Recommended for Testing)

Docker Compose file: `infra/docker-compose.atproto.yml`

```bash
# Start PDS
docker compose -f infra/docker-compose.atproto.yml up -d

# Verify
curl http://localhost:2583/xrpc/_health
```

**Ports:**
| Port | Service | Protocol |
|---|---|---|
| 2583 | PDS HTTP API | TCP |

### Public/Cloud Option
Use [bsky.social](https://bsky.social) as the PDS, but this requires real Bluesky accounts and isn't suitable for automated testing with throwaway data.

### Network Requirements
- Both devices must be able to reach the PDS over HTTP
- If self-hosting, port 2583 must be accessible from both machines
- PDS handles DID resolution via plc.directory (needs outbound internet)

### Infrastructure Cost
**Minimal.** Single container, ~100MB RAM, negligible disk.

### Persistence
Data lives in the PDS. If the PDS goes down, data in its volume persists. Without the PDS, no sync can occur.

---

## Nostr

### What's Needed
At least **one Nostr relay** that both devices can connect to. A relay is a simple WebSocket server that stores and forwards Nostr events.

### Self-Hosted (Recommended for Testing)

Docker Compose file: `infra/docker-compose.nostr.yml`

Uses [strfry](https://github.com/hoytech/strfry), a high-performance C++ relay.

```bash
# Start relay
docker compose -f infra/docker-compose.nostr.yml up -d

# Verify (WebSocket on port 7777)
nc -z localhost 7777
```

**Ports:**
| Port | Service | Protocol |
|---|---|---|
| 7777 | WebSocket relay | TCP (WS) |

### Public/Cloud Option
Public relays like `wss://relay.damus.io` or `wss://nos.lol` can be used, but add latency and may rate-limit. Self-hosted is strongly recommended for testing.

### Network Requirements
- Both devices must reach the relay via WebSocket
- Single port (7777 by default)
- No NAT issues — relay acts as intermediary

### Infrastructure Cost
**Minimal.** Single container, ~50MB RAM, disk scales with events stored.

### Persistence
Events are stored in the relay's database. If the relay restarts, events persist in the Docker volume. If the volume is deleted, all events are lost (but clients can re-publish).

---

## Matrix

### What's Needed
A **Matrix homeserver** that both devices can register accounts on and communicate through.

### Self-Hosted (Recommended for Testing)

Docker Compose file: `infra/docker-compose.matrix.yml`

Uses [Conduit](https://conduit.rs/), a lightweight Rust Matrix homeserver.

```bash
# Start homeserver
docker compose -f infra/docker-compose.matrix.yml up -d

# Verify
curl http://localhost:6167/_matrix/client/versions
```

**Ports:**
| Port | Service | Protocol |
|---|---|---|
| 6167 | Matrix HTTP API | TCP |

### Public/Cloud Option
Register accounts on [matrix.org](https://matrix.org), but rate limits and registration captchas make automated testing impractical.

### Network Requirements
- Both devices must reach the homeserver over HTTP
- For same-server testing, only port 6167 is needed
- Federation (multi-server) requires additional DNS/TLS setup

### Infrastructure Cost
**Minimal.** Conduit is very lightweight — ~30MB RAM, single binary in Docker.

### Persistence
Room state and messages are stored in the homeserver's database (RocksDB). Data persists across restarts if the volume is maintained.

---

## Solid

### What's Needed
A **Solid Pod server** that both devices can authenticate to and read/write Linked Data resources.

### Self-Hosted (Recommended for Testing)

Docker Compose file: `infra/docker-compose.solid.yml`

Uses [Community Solid Server (CSS)](https://github.com/CommunitySolidServer/CommunitySolidServer).

```bash
# Start server
docker compose -f infra/docker-compose.solid.yml up -d

# Verify
curl http://localhost:3000/
```

**Ports:**
| Port | Service | Protocol |
|---|---|---|
| 3000 | Solid HTTP API | TCP |

### Public/Cloud Option
[solidcommunity.net](https://solidcommunity.net) offers free pods, but requires manual account creation. [Inrupt Pod Spaces](https://start.inrupt.com/) is another option.

### Network Requirements
- Both devices must reach the Solid server over HTTP
- Single port (3000)
- Authentication may use WebID-OIDC

### Infrastructure Cost
**Minimal.** Single Node.js container, ~100MB RAM.

### Persistence
Data is stored as files/RDF in the server's volume. Persists across restarts. Volume deletion = data loss.

---

## IPFS

### What's Needed
IPFS daemons (kubo/go-ipfs) that can interact via the DHT or direct peering. The
compose file provisions **two** nodes on one host so cross-node exchange can be
exercised without a second machine.

### Self-Hosted (Recommended for Testing)

Docker Compose file: `infra/docker-compose.ipfs.yml` — brings up two kubo nodes,
`ad4m-test-ipfs-a` (API :5001) and `ad4m-test-ipfs-b` (API :5002), each with its
own named volume.

```bash
docker compose -p infra -f infra/docker-compose.ipfs.yml up -d

# Verify (node A)
curl -X POST http://localhost:5001/api/v0/id
```

`verify-ipfs.sh` reuses whatever already answers `:5001`, so a kubo node you run
for other purposes is left untouched (see the idempotency contract in
`interop/README.md`).

**Ports:**
| Port | Service | Protocol |
|---|---|---|
| 5001 | Node A HTTP API | TCP |
| 5002 | Node B HTTP API | TCP |
| 4001 | Swarm (libp2p, internal) | TCP + UDP |

### Public/Cloud Option
Public IPFS gateways exist for reading, but writing requires your own node. Pinning services (Pinata, Infura) can host content but add complexity.

### Network Requirements
- API port (5001) for AD4M executor communication
- Swarm port (4001) for peer discovery and data exchange
- Outbound internet for DHT bootstrap
- Both IPFS nodes need to be able to reach each other on port 4001

### Infrastructure Cost
**Minimal to moderate.** ~200MB RAM per node, disk scales with pinned content.

### Persistence
IPFS data is content-addressed and pinned locally. Unpinned data may be garbage-collected. Docker volume preserves the datastore across restarts.

---

## Hypercore

### What's Needed
A **sidecar gateway** — a Node.js process that manages Hyperswarm connections and Corestore feeds, exposing a REST API that the link language talks to via `httpFetch`.

The Deno executor runtime cannot run Hyperswarm natively (it requires Node.js `net`/`dgram`), so the gateway pattern bridges the gap.

### Self-Hosted (Required)

The gateway is a standalone Node.js process, not a Docker container:

```bash
mkdir -p /tmp/hypercore-gateway && cd /tmp/hypercore-gateway
npm init -y
npm install hypercore hyperswarm corestore express body-parser
# Create index.js — see reference in interop/scripts/languages/hypercore/
node index.js &
```

**Ports:**
| Port | Service | Protocol |
|---|---|---|
| 7778 | Gateway REST API | TCP (HTTP) |
| (dynamic) | Hyperswarm (UDP/TCP) | P2P |

### Gateway API

- `GET /status` — health check
- `GET /feeds` — list feeds
- `POST /feeds` — create feed
- `GET /feeds/:key/entries` — list entries
- `POST /feeds/:key/append` — append entry

### Network Requirements
- Gateway needs **outbound internet** for Hyperswarm DHT bootstrap
- **UDP** for hole-punching (may not work behind strict corporate firewalls)
- LAN discovery via mDNS is near-instant
- Both devices' gateways need to be able to discover each other via DHT

### Persistence
Hypercore data is append-only and stored locally by the gateway. Each peer maintains its own copy. No central point of failure.

### Notes
- The gateway is lightweight (~50MB RAM) but must stay running
- Consider increasing `SYNC_WAIT_SECONDS` for initial Hypercore tests (DHT discovery takes 5-15s)

---

## Docker Compose Files Reference

All compose files are in the repo-root `infra/` directory — one service per file,
so `infra_ensure`/`infra_teardown` can bring up and reclaim each backend in
isolation. (`interop/infra/` is unrelated — it holds only `conduit.toml`, the
Matrix homeserver config.)

| File | Protocol | Container(s) | Port(s) |
|---|---|---|---|
| `docker-compose.nostr.yml` | Nostr | `ad4m-test-nostr-relay` | 7777 |
| `docker-compose.matrix.yml` | Matrix | `ad4m-test-matrix-conduit` | 6167 |
| `docker-compose.solid.yml` | Solid | `ad4m-test-solid-server` | 3000 |
| `docker-compose.atproto.yml` | AT Protocol | `ad4m-test-atproto-pds` | 2583 |
| `docker-compose.ipfs.yml` | IPFS | `ad4m-test-ipfs-a`, `ad4m-test-ipfs-b` | 5001, 5002 |

### Common Operations

The verify scripts drive these through `infra-lib.sh`; you only need the commands
below to poke at a backend by hand. Always pass `-p infra` so the project name
matches what the scripts (and any stale container) use.

```bash
# Start / logs / stop one backend (from the repo root)
docker compose -p infra -f infra/docker-compose.nostr.yml up -d
docker compose -p infra -f infra/docker-compose.nostr.yml logs -f
docker compose -p infra -f infra/docker-compose.nostr.yml down -v
```

To reclaim everything the scripts started (and only that), use the marker-driven
safety net rather than a blind loop — it never touches reused or system services:

```bash
cd interop && ./teardown.sh
```

### Resource Estimates

Running all 5 infrastructure services simultaneously:

| Resource | Estimate |
|---|---|
| RAM | ~500MB total |
| Disk | ~1GB (images) + data volumes |
| CPU | Negligible at test scale |
| Network | LAN traffic only (if self-hosted) |
