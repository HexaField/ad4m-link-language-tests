# Link Language Capability Matrix

How each AD4M link language compares across protocol characteristics, security properties, and AD4M capabilities.

## Quick Reference

|  | Holochain | Matrix | Nostr | AT Proto | IPFS | Solid | Hypercore | ActivityPub | NextGraph | Git | peer2panda |
|--|-----------|--------|-------|----------|------|-------|-----------|-------------|----------|-----|------------|
| **Repo** | [p-diff-sync](https://github.com/coasys/ad4m/tree/dev/bootstrap-languages/p-diff-sync) | [matrix](https://github.com/coasys/matrix-link-language) | [nostr](https://github.com/coasys/nostr-link-language) | [atproto](https://github.com/coasys/atproto-link-language) | [ipfs](https://github.com/coasys/ipfs-link-language) | [solid](https://github.com/coasys/solid-link-language) | [hypercore](https://github.com/coasys/hypercore-link-language) | [ap](https://github.com/coasys/ap-link-language) | [nextgraph](https://github.com/coasys/nextgraph-link-language) | [git](https://github.com/coasys/git-link-language) | [peer2panda](https://github.com/coasys/peer2panda-link-language) |
| **Runtime** | WASM (Holochain) | Deno (ALDK) | Deno (ALDK) | Deno (ALDK) | Deno (ALDK) | Deno (ALDK) | Deno (ALDK) | Deno (ALDK) | Deno (ALDK) | Deno (ALDK) | Deno (ALDK) + Rust gateway |
| **Status** | Production | Verified | Verified | Verified | Verified | Verified | Verified | Verified | Verified (v0.1, local) | Verified (v0.1) | Verified (v0.1, local) |

---

## Network Topology

How data moves between participants.

|  | Holochain | Matrix | Nostr | AT Proto | IPFS | Solid | Hypercore | ActivityPub | NextGraph | Git | peer2panda |
|--|-----------|--------|-------|----------|------|-------|-----------|-------------|----------|-----|------------|
| **Topology** | P2P (DHT) | Federated | Relay | Cloud/Federated | P2P (DHT) | Client-Server | P2P (DHT) | Federated | P2P (CRDT mesh) | Local-first (Git repo) ¹⁴ | P2P (gossip) |
| **Infrastructure** | None (public bootstrap) | Homeserver | Relay(s) | PDS + Relay | Kubo daemon | Pod server | Sidecar gateway | None (executor built-in) | Sidecar gateway (NextGraph WASM) | None | Sidecar gateway (Rust p2panda) + iroh relays |
| **Self-hostable** | N/A | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | N/A | ✅ | ✅ (any Git host) | ✅ |
| **Works offline** | Partial ¹ | ❌ | ❌ | ❌ | Partial ² | ❌ | Partial ¹ | ❌ | ✅ (local-first CRDT) | ✅ | ✅ (local-first log) ²⁰ |
| **NAT traversal** | ✅ (Holochain proxy) | N/A (server) | N/A (relay) | N/A (server) | ✅ (libp2p) | N/A (server) | ✅ (Hyperswarm) | N/A (server) | ✅ (NextGraph broker) | N/A ¹⁵ | ✅ (iroh hole-punch + relay) |

¹ Local reads work; writes queue until reconnected to DHT / peers.
² Local pinned content readable; writes need API access.
¹⁴ Local-first: commits land in the on-disk repo immediately. Remote sync is automated for **GitHub** (pull + push over the provider JSON REST API); **Radicle** is read-convergent with out-of-band push via the local `rad` node; a shared filesystem / external `git pull` also carries state. See ¹⁷.
¹⁵ Git's remote leg is HTTPS to the forge (GitHub) or out-of-band (Radicle local node / shared filesystem) — client-server, so there is no P2P NAT traversal to perform; the GitHub transport is TLS.
²⁰ Writes land in the local append-only log immediately and gossip to peers on reconnect.

---

## Identity & Authentication

How participants are identified and authenticated.

|  | Holochain | Matrix | Nostr | AT Proto | IPFS | Solid | Hypercore | ActivityPub | NextGraph | Git | peer2panda |
|--|-----------|--------|-------|----------|------|-------|-----------|-------------|----------|-----|------------|
| **Native identity** | AgentPubKey (Ed25519) | MXID (`@user:server`) | npub (secp256k1) | DID (did:plc / did:web) | PeerID (libp2p) | WebID (URI) | Feed public key | Actor URI | NextGraph Wallet (Ed25519) | Git committer (DID-derived) | Ed25519 node key |
| **AD4M identity** | DID (mapped via zome) | DID (embedded in events) | DID (embedded in events) | DID (embedded in records) | DID (embedded in DAG) | DID (embedded in RDF) | DID (embedded in blocks) | DID (extracted from actors) | DID (embedded in triples) | DID (link expression proof + commit author) | DID (embedded in operation) |
| **Sovereign identity** | ✅ ³ | ❌ ⁴ | ✅ | ❌ ⁵ | ✅ | ❌ ⁶ | ✅ | ❌ ⁷ | ✅ | ✅ ¹⁶ | ✅ |
| **Auth mechanism** | Membrane proof | Access token | Keypair (BIP-340) | App password + session | None (public API) | WebID-OIDC / token | Feed key possession | HTTP Signatures | Wallet password | AD4M agent keypair | Ed25519 operation signature |

³ AgentPubKey is self-generated; no registration authority.
⁴ MXID is server-issued; identity is portable across servers only via migration.
⁵ did:plc resolution depends on plc.directory; did:web depends on DNS. Portable but not fully sovereign.
⁶ WebID is server-hosted; identity depends on pod provider.
⁷ Actor URI is domain-bound; identity depends on the hosting server.
¹⁶ The Git committer field encodes the AD4M agent DID. No registration authority; identity is self-generated.

---

## Security & Encryption

|  | Holochain | Matrix | Nostr | AT Proto | IPFS | Solid | Hypercore | ActivityPub | NextGraph | Git | peer2panda |
|--|-----------|--------|-------|----------|------|-------|-----------|-------------|----------|-----|------------|
| **Transport encryption** | ✅ (TLS to bootstrap/proxy) | ✅ (HTTPS to homeserver) | ✅ (WSS to relay) | ✅ (HTTPS to PDS) | Varies ⁸ | ✅ (HTTPS to pod) | ✅ (Noise protocol) | ✅ (HTTPS) | ✅ (TLS to broker) | ✅ (HTTPS to forge) ¹⁵ | ✅ (TLS 1.3 via QUIC/iroh) |
| **E2E encryption** | ❌ ⁹ | Configurable ¹⁰ | ❌ ¹¹ | ❌ | ❌ | ❌ | Configurable ¹² | ❌ | ✅ (wallet-level) | ❌ ¹⁵ | ❌ ²¹ |
| **Content signing** | ✅ (Holochain DHT) | ✅ (AD4M proof) | ✅ (Schnorr BIP-340) | ✅ (AT repo signing) | ✅ (content-addressed) | ✅ (AD4M proof) | ✅ (feed signature) | ✅ (HTTP Signatures) | ✅ (AD4M proof) | ✅ (AD4M proof + commit hash chain) | ✅ (Ed25519 ops + AD4M proof) |
| **Data at rest** | Encrypted (conductor DB) | Server-controlled | Relay-controlled | PDS-controlled | Public (content-addressed) | Pod-controlled | Configurable ¹² | Server-controlled | Encrypted (wallet) | Filesystem ACL (executor data dir) | SQLite op store (gateway) |
| **Data deletion** | ❌ (DHT, eventual) | ✅ (redaction) | ✅ (replaceable events) | ✅ (repo delete) | ❌ (content-addressed) | ✅ (resource delete) | ❌ (append-only) | ✅ (Delete activity) | ✅ (CRDT remove) | ✅ (forward-inverse commit; history preserved) | ❌ (append-only; tombstone ops) |

⁸ Kubo API is typically HTTP (localhost); swarm connections use libp2p encryption.
⁹ DHT entries are public to the network; the DNA hash acts as a namespace boundary, not an encryption boundary.
¹⁰ Matrix language has E2EE settings (`encryption.enabled`), wrapping content in encrypted room events. Requires Olm/Megolm key exchange.
¹¹ Nostr supports NIP-04/NIP-44 encrypted DMs at the protocol level, but the link language currently uses public events (kind:9078).
¹² Hypercore language supports symmetric key encryption of feed blocks (`encryption.ts`). Peers must share the key out-of-band.
²¹ p2panda ships an optional data-encryption layer (MLS-style groups); the link language does not yet enable it, so operations are signed but transmitted in cleartext CBOR to topic subscribers.

---

## AD4M Capabilities

What each language implements from the AD4M Language Interface.

|  | Holochain | Matrix | Nostr | AT Proto | IPFS | Solid | Hypercore | ActivityPub | NextGraph | Git | peer2panda |
|--|-----------|--------|-------|----------|------|-------|-----------|-------------|----------|-----|------------|
| **perspective-commit** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (one commit per diff) | ✅ |
| **perspective-sync** | ✅ (diff-DAG + scribe) | ✅ (state-events + state-res-v2) | ✅ (e-tag DAG + OR-Set) | ✅ (MST chain + OR-Set) | ✅ (multi-parent DAG + OR-Set) | ✅ (diff-resource DAG + OR-Set) | ✅ (Autobase + OR-Set) | ✅ (activity DAG + OR-Set) | ✅ (native CRDT) | ✅ ¹⁷ (commit-DAG + OR-Set) | ✅ (op-log + OR-Set) |
| **↳ currentRevision** ²² | DAG-head hash | state digest | head-event-id hash | commit-CID digest | head-CID hash | head diff-resource hash | Autobase root hash | head-activity-id hash | native commit CID | HEAD SHA | BLAKE3 op-head digest |
| **↳ merge authority** | scribe | state-resolution-v2 | OR-Set | MST + OR-Set | OR-Set | OR-Set | Autobase | OR-Set | native CRDT | OR-Set + git-merge | p2panda partial order |
| **perspective-query** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ + 3 custom kinds ¹⁸ | ✅ |
| **peers** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| **telepresence** | ✅ (native DHT) | ✅ (Presence API) | ✅ (ephemeral events) | ❌ | ✅ (PubSub) | ❌ | ✅ (Hyperswarm peers) | ❌ | ❌ | ❌ | ❌ |
| **dual-language** | N/A (primary) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **sync modes** | Bidirectional | Bi / Pub / Sub | Bi / Pub / Sub | Bi / Pub / Sub | Bi / Pub / Sub | Bi / Pub / Sub | Bi / Pub / Sub | Bi / Pub / Sub | Bidirectional | Bi (GitHub) / out-of-band (Radicle) ¹⁷ | Bidirectional |

**perspective-sync** means *bidirectional full-replica convergence*: two agents that have observed the same link diffs converge to the same Perspective regardless of order or partition. The reference (Holochain `p-diff-sync`) achieves this with a **hash-linked diff-DAG** — `commit(diff)` appends a content-addressed node and `currentRevision()` returns a hash into it. An earlier version of this matrix graded every language ✅ because it *exported a sync function*; that is export-presence, not convergence. The grades above track convergence.

Every language plays **two roles**, kept separate:
- **Role A — convergence substrate:** a content-addressed, causal, mergeable diff-DAG that is the AD4M-facing source of truth. The `currentRevision` and `merge authority` rows describe it.
- **Role B — native projection:** a derived view in the protocol's own idiom (Matrix chat, Nostr kind-1 notes, AP/AT Proto posts, Solid RDF, git working tree), for native users of that protocol. For the plain-text protocols (Matrix, Nostr, ActivityPub, AT Proto) and Solid this is now a **shared, SHACL-driven transformer** (`src/projection/`, copied verbatim per repo): a `NodeShape` annotated with `projection://nativeType` decides which graph property fills the native content, the projection is a pure fold of Channel A that is **never read back to rebuild the DAG**, and the single inbound exception — genuinely native-authored content from a user with no AD4M DID — is echo-suppressed and ingested as new Role-A links. Described by [Data Model & Storage](#data-model--storage) and ²³.

The **litmus test** for Role A is `currentRevision()` returning a *content hash of the DAG head(s)* — never a timestamp, ETag, batch token, or sequence integer. All eleven languages now pass it. Merge is either the protocol's **native authority** (Holochain scribe, Matrix state-resolution-v2, Hypercore Autobase, NextGraph CRDT, AT Proto MST) or an **OR-Set keyed by link hash** — links are immutable content-addressed elements, so add/remove/merge converge deterministically with no coordinator, and removals carry the *original* link hash so they converge against their add.

**Verification status:** each repo's unit tests assert the revision is a content hash stable across restarts, that folding the DAG from genesis reproduces the materialised link set, that concurrent add/remove resolve deterministically, and that diff application is order-independent. Live *multi-agent* convergence over running infrastructure (relay, homeserver, PDS, broker, swarm) is exercised by the **C1 convergence scenario** (`src/scenarios/c1-convergence.ts`), which installs a language into **two** real executors sharing one neighbourhood over its live backend and asserts cross-agent link-set equality — a per-executor unit test cannot prove this because a mock transport does not enforce relay/runtime semantics.

C1 has been **run end-to-end against a live backend for Nostr** (strfry relay): both agents reached **20/20 links in 2.0 s** and a removal/tombstone propagated in **3.1 s**. That run earned its keep — it surfaced **three real defects invisible to 318 passing unit tests**: (1) strfry's placeholder write-policy whitelist rejecting every event; (2) the NIP-01 single-letter tag-indexing rule (a REQ keyed on the multi-char `#ad4m:neighbourhood` tag is rejected and delivers nothing — subscriptions must filter `#d`); and (3) **the executor discarding a link language's `sync()` return value** — inbound folds become queryable only when pushed through the `emitPerspectiveDiff` host channel, not merely returned. All three are documented in the harness `AGENTS.md`. The other backends' C1 runs are not yet part of CI and are called out per-language rather than assumed. Git's GitHub remote sync (pull + push) is unit-tested against a request-recording mock; live forge round-trips and Radicle publish are out-of-band from CI ¹⁷.

C1 has also been **run end-to-end for NextGraph** (Node/WASM sidecar gateway, one shared wallet/session/store both executors ride): both agents reached **20/20 links in 5.0 s** and a removal converged in **6.1 s**. This is the run that lifted NextGraph from *Alpha* — it too earned its keep, surfacing **three stacked defects invisible to the unit suite** because each depends on live two-agent timing against the real WASM CRDT: (1) **RDF-star annotation rows poisoning the fold** — the gateway writes link metadata as reified `<< s p o >> <core/author> "…"` statements, and a bare `SELECT ?s ?p ?o` also matched those, binding the subject to a *quoted-triple object* rather than an IRI, so the client's `decodeUri` threw `uri.startsWith is not a function` and aborted **every** sync fold, freezing each replica at its own 10 links (fixed with a gateway `FILTER(isIRI(?s))` plus a defensive base-triple skip in the language fold); (2) the **single-threaded, non-reentrant WASM session** dropping connections mid-response (`connection closed before message completed`) whenever both agents' 3 s sync loops hit it concurrently (fixed with a promise-chain mutex serialising every native call); and (3) a **sync-cursor contamination** where reusing the AD4M revision as the sync `since` let the gateway's `since === head → unchanged` short-circuit suppress a peer's triples after a local commit advanced the shared-store head (fixed by tracking a distinct fold cursor that advances only after a successful fold). All three are documented in the [nextgraph-link-language](https://github.com/coasys/nextgraph-link-language) `AGENTS.md`.

C1 has also been **run end-to-end for peer2panda** (Rust sidecar gateway wrapping the p2panda v0.7 stack; in the co-located C1 model both executors share one gateway node): both agents reached **20/20 links in 4.1 s** and a removal converged in **6.1 s**, the gateway settling to 20 add + 1 remove ops, a BLAKE3 op-head revision digest, and 19 live triples. This run earned its keep by catching an **operational hazard the unit suite cannot see**: the gateway's `target/` is git-ignored, so a long-lived gateway process was serving a binary built *before* the op-log/OR-Set rework. That stale binary converged adds (the language dedups by triple key) but every removal was a **silent no-op** — it had no OR-Set to tombstone against — and its `currentRevision` was a `rev-N` counter rather than the content hash the litmus test demands. Rebuilding from source (all 14 gateway unit tests green, including observed-remove and order-independence) and re-running produced the honest pass above. The tell for a stale gateway — `revision: "rev-N"` with absent `heads`/`opHash` fields — is documented in the [peer2panda-link-language](https://github.com/coasys/peer2panda-link-language) `AGENTS.md`.

C1 has also been **run end-to-end for Hypercore** (Node sidecar gateway wrapping Corestore + Autobase; in the co-located C1 model both executors share one gateway node): both agents reached **20/20 links in 1.0 s** and a removal converged in **3.1 s**. This run earned its keep by surfacing **three defects invisible to the in-process suites**, each dependent on live two-agent semantics: (1) a **phantom-bootstrap** trap — an Autobase key is a *generated* bootstrap-writer core key, not a namespace you can choose, so templating `hex32(neighbourhoodId)` as a bootstrap key made every executor open a **non-writable** base and every commit `409`'d; fixed with a co-located **neighbourhood-handle rendezvous** where both agents resolve the handle to one freshly-created writable base (create-once per handle); (2) a **commit-cursor-skip** — the gateway linearizes every writer into one op-log with a single global seq, and the language advanced its `diff?since` cursor to a local commit's global seq, permanently **skipping peer ops already interleaved below it**, freezing each replica at its own 10 links (the observed A=10/B=10 non-convergence); fixed by never advancing the fold cursor on a local commit (`sync()` owns the cursor, `noteLocalCommit()` only caches the revision); and (3) **the executor discarding `sync()`'s return value** (the same host-contract trap Nostr hit) — Hypercore's `sync()` folded inbound ops into its derived cache and returned the diff but never pushed them through `emitPerspectiveDiff`, so peer links never became queryable; fixed by routing the inbound delta through the runtime adapter's `emitPerspectiveDiff`. All three, plus two regression tests that lock the cursor and emit invariants, are documented in the [hypercore-link-language](https://github.com/coasys/hypercore-link-language) `AGENTS.md`.

C1 has also been **run end-to-end for Solid** (Community Solid Server 7.1.9 with in-memory storage + allow-all authorization; both executors PUT/GET diff-commit resources into one shared pod container): both agents reached **20/20 links in 1.0 s** and a removal converged in **3.0 s**. This run earned its keep by surfacing **three defects invisible to 282 passing unit tests**, each dependent on live two-agent semantics against a real pod: (1) **the executor discarding `sync()`'s return value** (the same host-contract trap Nostr and Hypercore hit) — Solid's `sync()` walked the pod's `ad4m:previous` diff-DAG and folded inbound commits into its own store but returned the delta instead of pushing it, so peer links never became queryable and each replica froze at its own 10 links; fixed by routing the before/after fold delta through `getRuntime().emitPerspectiveDiff`; (2) a **URL-join bug** — the harness templates a no-trailing-slash pod URL and a no-leading-slash container path, and the builders concatenated them into the invalid `http://…:3005ad4m/…/diffs/`, so every `httpFetch` threw and no agent ever read a peer's commits (the same surface A=10/B=10 freeze, different cause); the builders now normalise through a `joinPodPath` helper that rejoins with exactly one separator; this was masked because the unit fixtures used leading-slash container paths that happen to concatenate correctly; and (3) an **OR-Set identity-key bug** — the link content hash keyed on `proof`, but AD4M's `removeLink` hands the language an **empty-proof tombstone** (the executor does not round-trip the signature), so a tombstone could never reference the signed add a peer had folded; adds converged 20/20 but every removal froze; fixed by dropping `proof` from the key (keeping `timestamp`, which does round-trip), matching the Nostr/IPFS convention. All three, plus regression tests for the emit contract, the slash-normalisation matrix, and proof-stripped tombstone convergence, are documented in the [solid-link-language](https://github.com/coasys/solid-link-language) `AGENTS.md`.

C1 has also been **run end-to-end for Matrix** (Conduit homeserver; both executors share one provisioned Matrix user, access token, and room, writing links as `dev.ad4m.link` room **state events** keyed by link-hash `state_key` and merging via the homeserver's **state-resolution-v2**): both agents reached **20/20 links in 1.05 s** and a removal converged in **3.05 s**. Unlike the four backends above, this run surfaced **no defect** — the Matrix language was already built to the host contract the others tripped on, and honesty is served by recording that rather than manufacturing a fix. Its `sync()` GETs the homeserver's *resolved* room state (state-resolution-v2 yields exactly one winning event per `state_key`), reconciles it against a persisted snapshot into a `PerspectiveDiff`, and — critically — pushes that diff through `emitPerspectiveDiff` rather than merely returning it, so peer links become queryable and both replicas reach 20/20 without the A=10/B=10 freeze the executor's **discarded-`sync()`-return-value** trap produces (the trap that bit Nostr, Hypercore, and Solid). Because both agents share one repo of room state, convergence rides Matrix's own authority with no OR-Set needed. Provisioning — a Matrix User-Interactive-Auth `m.login.dummy` registration plus `createRoom` — runs once per C1 run in the harness `src/convergence/provision.ts`.

C1 has also been **run end-to-end for AT Protocol** (Bluesky reference PDS `pds` 0.4.x; both executors share one provisioned DID + app-password and write adds as `ad4m.link.triple` records and removals as `ad4m.link.tombstone` records via `com.atproto.repo.applyWrites`, riding the repo's **MST commit chain** with the neighbourhood state a **cross-repo OR-Set union** — co-located, that is one shared repo): both agents reached **20/20 links in 4.05 s** and a removal converged in **3.05 s**. This run earned its keep by surfacing **two layered defects invisible to the unit suite**, the second only visible once the first was fixed: (1) **the executor discarding `sync()`'s return value** (the same host-contract trap Nostr, Hypercore, and Solid hit) — the atproto `sync()` diffed peer commit heads and folded the inbound records into its store but returned the delta instead of pushing it, so peer links never became queryable and each replica froze at its own 10 links; fixed by routing both `init()` and the sync handler through a single `foldAndEmit` seam (`src/sync.ts`) that folds **and** pushes the delta through `getRuntime().emitPerspectiveDiff`; and (2) an **rkey collision on the shared repo** — the record key was derived as `tidFromISO(link.timestamp)`, a TID at millisecond resolution, so two **distinct** links written in the same millisecond by the two co-located agents produced the **same rkey**; AT Proto rejects an `applyWrites#create` at an existing rkey, so the second write was silently dropped and the PDS held only **18 of 20** triples (both replicas stuck at A=18/B=18 even after the emit fix). Fixed by making the triple rkey the link's **OR-Set content hash** `linkHash(link)` — content-addressed, so it is unique per distinct link, identical for the same link across agents, and matches both the tombstone's key and the add↔delete pairing across proof-stripping (a delete now targets the exact record the add created). Both, plus regression tests for the emit contract and cross-agent rkey-collision safety, are documented in the [atproto-link-language](https://github.com/coasys/atproto-link-language) `AGENTS.md`.

C1 has also been **run end-to-end for ActivityPub** (a dependency-free AS2 group actor standing in for a Lemmy/Guppe-style Fediverse group; both co-located executors POST diff activities to the group inbox and pull them back from the reflected group outbox, folding an **emulated `prev` hash-DAG carried inside the activity stream** — ActivityPub has no native causal DAG, so each diff-DAG node rides as a `Create{Note}` whose Note carries one `ad4m:Diff` tag `{ diffId, prev[], removals[] }` plus one `ad4m:Link` tag per addition): both agents reached **20/20 links in 1.05 s** and a removal converged in **3.05 s**, the group's outbox settling to **21 diff activities** (20 adds + 1 removal) folded identically on both replicas. This run earned its keep by surfacing **two defects invisible to 256 passing unit tests**, each dependent on live two-agent semantics: (1) **the executor discarding `sync()`'s return value** (the same host-contract trap Nostr, Hypercore, Solid, and AT Proto hit) — AP's `syncFromOutbox` walked the emulated `prev` DAG and folded inbound diff nodes but returned the delta instead of pushing it, so peer links never became queryable and each replica froze at its own 10 links; fixed by emitting the combined fold delta through `emitPerspectiveDiff` after every outbox sync; and (2) **the DAG node author not round-tripping through the AP encoding** — the committing agent's DID is part of a node's content hash (`dag.canonicalDiff` folds `author` into the id), and `sync.ingestDiffActivities` re-seals each decoded node and drops it if the recomputed id ≠ its `ad4m:diffId`; the decoder reconstructed the author from the **AP actor URL** (`ap:${actor}`) instead of carrying the DID, so every peer node re-sealed to a *different* id and was **silently rejected** — the observed A=10/B=10 partition (delivery was fine: all 20 activities reached the outbox; each agent simply kept only its own 10 nodes). Fixed by carrying `ad4m:author: node.author` on the `ad4m:Diff` tag and reading it back on decode (the AP-actor-URL fallback is retained only for pre-fix activities, which correctly fail re-seal). The key subtlety: link-*level* additions already round-tripped `ad4m:author`/`ad4m:timestamp`, so link hashes matched — only the *node-level* author was lost, which is why adds looked like they federated (activities arrived) yet nothing merged. Both, plus a §5.5 regression test that federates two replicas through the **real** `diffNodeToActivity → activityToDiffNode` encoding with a non-DID actor URL (the existing `transport()` fixture copied raw node bytes and could never catch an encoding-layer author-loss bug), are documented in the [ap-link-language](https://github.com/coasys/ap-link-language) `AGENTS.md`.

C1 has also been **run end-to-end for Git** (a dependency-light co-located git-data server — `infra/git-data-shim.mjs` on `:7792`, backed by the same `isomorphic-git` the language hashes with, so the push path's `returnedSha === localOid` assertions hold by construction; both executors template one shared repo `c1/<neighbourhoodId>`, `GIT_API_BASE` pointing the GitHub-REST provider at the shim with `owner/repo` read from the `REMOTE_URL` path, so no github.com is touched; each agent POSTs blobs → trees → commits and PATCHes the ref, a non-fast-forward `422` triggering pull → **OR-Set-over-commit-ancestry** merge → retry, with the background pull timer fast-forwarding both sides to the shared head): both agents reached **20/20 links in 6.06 s** and a removal converged in **2.05 s**. Unlike the eight backends above, the defect this run surfaced was **not** a convergence-logic bug but a **masked bundle-load failure** — the language never loaded at all, and had been miscategorised as a hard block needing live GitHub credentials. Two stacked causes, neither visible without a live executor: (1) **the per-language sandbox denies env access** (`allow_env:none`) — `isomorphic-git` pulls in the `ignore` package, whose module-init reads `process.env.IGNORE_TEST_WIN32`; under the executor's Deno node-compat a *keyed* `process.env` read routes through `Deno.env.get`, throws `NotCapable`, and aborts evaluation of the **entire** bundle before the language constructor is exposed; fixed with an esbuild `define` folding that read to a build-time constant so no runtime env access survives (git is the only language bundling a dep that probes env at import); and (2) **the executor was mislabelling the error** — `SmartGlobalVariableFuture::poll` caught every event-loop failure, logged the real one, then returned a hardcoded `CoreError::TLA` ("Top-level await is not allowed in synchronous evaluation"), so the true `NotCapable` denial surfaced across multiple sessions as a phantom top-level-await error with no top-level await anywhere in the bundle; fixed in the executor by propagating the actual error. The build-time fix plus a `tests/bundle-sandbox.test.ts` regression guard (asserting the shipped bundle carries no permission-gated `process.env` read and no surviving bare-builtin `__require`) are documented in the [git-link-language](https://github.com/coasys/git-link-language) `AGENTS.md`; the executor observability fix rides a separate `ad4m` branch. Live github.com round-trips and Radicle publish remain out of CI (see ¹⁷) — the hermetic shim proves convergence against the GitHub REST *contract*, not the hosted service.

**Telepresence** = real-time presence and signalling (online status, peer-to-peer signals, broadcast). Implemented via:
- **Holochain**: DHT-based `get_online_agents` + `send_signal` zome calls
- **Matrix**: Presence API (`/_matrix/client/v3/presence`) + to-device messages for signalling
- **Nostr**: Ephemeral events (kind 20042-20044, NIP-16) via WebSocket subscriptions
- **Hypercore**: Hyperswarm peer tracking via sidecar gateway REST API

AT Proto, IPFS, Solid, ActivityPub, NextGraph, and peer2panda lack a real-time bidirectional channel suitable for presence — AT Proto's firehose is one-way, IPFS PubSub is experimental, Solid notifications are container-level, AP is HTTP push only, NextGraph does not yet expose ephemeral messaging APIs to the client SDK, and peer2panda's gossip overlay could carry ephemeral signals but the link language does not yet expose them.

**Dual-language** = can coexist alongside Holochain (p-diff-sync) in the same Neighbourhood, with origin tracking to prevent echo loops. Holochain is the primary language, so dual-language doesn't apply to it.

NextGraph telepresence may be added in future versions if native support is added to the SDK or via a secondary layer (e.g. libp2p).

¹⁷ Git's `sync()` detects HEAD movement — whether applied by the automated remote loop, an external `git pull`, or shared storage between agents — and emits the resulting PerspectiveDiff. When two peers' histories diverge, `sync()` walks the commit ancestry and merges via an **OR-Set keyed by link hash** (add = link blob; remove = tombstone carrying the original link hash), deriving the delta from the commit op-log rather than a base-vs-head snapshot — so an add-then-remove converges correctly and merge order no longer matters. Automated remote sync now rides provider **JSON REST APIs**, side-stepping the pack-file smart protocol that `httpFetch` mangles (it UTF-8-decodes binary bodies): **GitHub** pulls (ETag-conditional, 60 s default) and **pushes** (trailing-edge debounced mirror — `POST` blobs → trees → commits, `PATCH` the ref, every write asserting the SHA GitHub returns equals the local OID, non-fast-forward → pull + OR-Set merge + one retry). **Radicle** is read-convergent through `radicle-httpd`'s JSON read API; it exposes no JSON write path, so `canPush = false` and publishing is out-of-band via the operator's local `rad` node. The backing forge is chosen by the `REMOTE_KIND × REMOTE_URL` instance parameters (`auto` infers from the URL). The push path is unit-tested against a request-recording mock asserting the exact REST contract; live GitHub round-trips are out of CI. See [git-link-language](https://github.com/coasys/git-link-language).

¹⁸ Git is the first language to ship custom `perspective-query` kinds beyond `link-pattern`:
- `git-history` — walks the commit DAG, returns CommitRecords with link-hash additions/removals
- `git-state-at` — renders the Perspective as it existed at any past SHA
- `git-blame` — locates the commit that introduced a given link hash

²² `currentRevision()` is the convergence litmus: a content hash of the DAG head(s). For single-head protocols it is the native head hash verbatim (git HEAD SHA, NextGraph commit CID); for multi-writer protocols with no single head it is a deterministic digest of the *set* of per-writer head hashes (a version-vector digest). A revision that is a timestamp, ETag, batch token, or sequence integer indicates the language is snapshot-diffing a native projection rather than riding a real diff-DAG.

---

## Access Control & Membership

How each language controls who can read and write.

|  | Holochain | Matrix | Nostr | AT Proto | IPFS | Solid | Hypercore | ActivityPub | NextGraph | Git | peer2panda |
|--|-----------|--------|-------|----------|------|-------|-----------|-------------|----------|-----|------------|
| **Read access** | DNA hash (namespace) | Room membership | Public ¹³ | Public ¹³ | Public (CID) | ACL (WAC) | Feed key | Public | Wallet ReadCap | Filesystem / Git host ACL | Topic subscription |
| **Write access** | Membrane proof | Room power levels | Pubkey list or open | DID list or open | Open (anyone can pin) | ACL (WAC) | Writer keys (Autobase) | Followers / allowlist / admin | Wallet WriteCap | Filesystem / Git host ACL | Open (any author key) |
| **Membership model** | Progenitor-controlled | `open` / `invite-only` | `open` / `pubkey-list` | `open` / `followers-only` / `list-only` | Open | `open` / `members-only` / `private` | Writer key management | `open` / `followers-only` / `members-only` / `admin-approved` | Capability-based | Out-of-band (Git host or shared filesystem) | Open (topic-based) |
| **Rate limiting** | ❌ (DHT natural) | ✅ (client-side) | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ (per-actor) | ❌ | N/A (local) | ❌ |

¹³ Nostr relay events and AT Proto repo records are publicly readable by default. Access control requires relay-level or PDS-level configuration, not the link language.

---

## Data Model & Storage

How links are represented in each protocol's native format.

|  | Holochain | Matrix | Nostr | AT Proto | IPFS | Solid | Hypercore | ActivityPub | NextGraph | Git | peer2panda |
|--|-----------|--------|-------|----------|------|-------|-----------|-------------|----------|-----|------------|
| **Native format** | DHT entry (Action + Entry) | State event (`dev.ad4m.link`) | kind:9078 event (regular) | Repo record (`ad4m.link.triple` / `.tombstone`) | DAG-JSON commit (multi-parent) | Immutable diff resource (`diff-<hash>.ttl`) | Feed block (JSON) | AP Activity (`ad4m:Diff` tag) | RDF Triple (SPARQL) | JSON file `links/<hash>.json` | Signed CBOR operation |
| **Storage location** | Holochain DHT | Homeserver DB | Relay DB | PDS repo | IPFS datastore | Pod filesystem | Hypercore feed | Inbox/Outbox | NextGraph wallet/store | Git working tree (executor data dir) | p2panda SQLite op store (gateway) |
| **Content-addressed** | ✅ (entry hash) | ❌ | ✅ (event ID) | ❌ (rkey) | ✅ (CID) | ✅ (diff resource) | ❌ (seq number) | ✅ (diff activity) | ✅ (commit CID) | ✅ (hash filename) | ✅ (BLAKE3 op hash) |
| **Append-only** | ✅ (DHT) | ❌ | ✅ (regular events) | ❌ | ✅ | ✅ (immutable diffs) | ✅ | ✅ (immutable diffs) | ❌ (CRDT) | ✅ (commit history) | ✅ (per-author log) |
| **Merkle structure** | ✅ (DHT) | ❌ | ✅ (e-tag DAG) | ✅ (MST) | ✅ (DAG) | ✅ (diff-resource DAG) | ✅ (Merkle tree) | ✅ (activity DAG) | ✅ (DAG) | ✅ (Git commit DAG) | ✅ (BLAKE3 hash chain) |
| **Human-readable** | ❌ | ✅ (dual render) | ✅ (kind-1 notes) ²³ | ✅ (Bluesky posts) ²³ | ❌ (DAG-JSON) | ✅ (RDF/Turtle) | ❌ | ✅ (Note content) | ❌ (SPARQL/RDF) | ✅ (JSON + `git log`) | ❌ (CBOR) |
| **Native app visibility** | N/A | Element, other Matrix clients | Nostr clients (kind-1 notes: Snort, Damus) | Bluesky (app.bsky.feed.post) | IPFS Gateway / Desktop | Penny, Mashlib, any Solid app | hyp CLI | Mastodon, Pleroma, Misskey | NextGraph apps | `git` CLI, GitHub / GitLab / Gitea web UIs | Other p2panda nodes (same topic) |

Since the diff-DAG rework, the **Content-addressed**, **Append-only**, and **Merkle structure** rows describe the AD4M-facing convergence substrate (Role A) — the content-hash-linked diff-DAG each language persists — rather than the human-facing native projection (Role B) covered by **Native format**, **Human-readable**, and **Native app visibility**. Languages that ride a native DAG (IPFS, AT Proto, Hypercore, Git, peer2panda, NextGraph) reuse it directly; Nostr, Solid, and ActivityPub *emulate* one with content-hash parent pointers (Nostr e-tag chains, Solid `ad4m:previous`, AP `ad4m:prev`). Matrix keys links by hash into room **state** and rides state-resolution-v2 for merge, so its convergence substrate is the state store rather than a Merkle log — hence ❌ on the log-shaped rows but ✅ on perspective-sync.

²³ **Channel-B native projection.** Since the shared SHACL-driven projection module landed, Matrix, Nostr, ActivityPub, AT Proto, and Solid render AD4M links as first-class native content (Matrix `m.room.message`, Nostr kind-1 notes, AS2 `Note`, `app.bsky.feed.post`, native RDF) rather than opaque diff blobs — a `NodeShape` carrying `projection://nativeType` selects which graph property fills the native body, and only annotated shapes project. The projection is unit-tested for native-payload shape and for echo-suppressed native ingest (a native message is ingested as new Role-A links only when its author has no known AD4M DID); live rendering in each third-party client (Snort, Damus, Mastodon, Bluesky) is exercised only where a wind-tunnel scenario has a reachable backend, per **Verification status** above. The transform core (`src/projection/`) is protocol-agnostic and copied verbatim into each language; only a thin per-protocol `NativeAdapter` maps the generic projection to/from that protocol's wire object.

---

## Scalability & Performance

|  | Holochain | Matrix | Nostr | AT Proto | IPFS | Solid | Hypercore | ActivityPub | NextGraph | Git | peer2panda |
|--|-----------|--------|-------|----------|------|-------|-----------|-------------|----------|-----|------------|
| **Sync latency** | ~1-10s (gossip) | ~1s (HTTP poll) | ~1s (WebSocket push) | ~1s (HTTP poll) | ~5-30s (DHT + IPNS) | ~1s (HTTP poll) | ~1-5s (DHT + gateway poll) | ~1-10s (HTTP delivery) | ~1-5s (CRDT propagation + gateway poll) | Local: ms; GitHub: ~60s pull / ~5s debounced push; Radicle: out-of-band | ~1-5s (gossip + gateway poll) |
| **Horizontal scaling** | ✅ (DHT shards) | ✅ (homeserver federation) | ✅ (relay multiplexing) | ✅ (PDS federation + relay) | ✅ (DHT) | Limited (single pod) | ✅ (Hyperswarm) | ✅ (server federation) | ✅ (CRDT mesh) | ✅ (any Git host) | ✅ (gossip overlay) |
| **Max neighbourhood size** | DHT-limited (thousands) | Server-limited | Relay-limited | PDS-limited | DHT-limited | Server-limited | Feed-limited | Server-limited | CRDT-limited | Git-repo-limited ¹⁹ | Gossip-limited |
| **Bandwidth efficiency** | Gossip (efficient) | Polling (moderate) | Subscription (efficient) | Polling (moderate) | Polling (moderate) | Polling (moderate) | Polling (moderate) | Push delivery (efficient) | CRDT delta sync (efficient) | Pack files (very efficient) | Gossip + log-height sync (efficient) |

¹⁹ Practical ceilings follow standard Git advice — GitHub recommends keeping repos under ~1GB and under ~100K files. Render time grows linearly with link count ([git-link-language](https://github.com/coasys/git-link-language)).

---

## Protocol Interoperability

How each language relates to the broader protocol ecosystem.

|  | Holochain | Matrix | Nostr | AT Proto | IPFS | Solid | Hypercore | ActivityPub | NextGraph | Git | peer2panda |
|--|-----------|--------|-------|----------|------|-------|-----------|-------------|----------|-----|------------|
| **Standards body** | Holochain Foundation | matrix.org Foundation | NIP process (community) | Bluesky PBC | IPFS / Protocol Labs | W3C Solid CG | Holepunch | W3C ActivityPub | NextGraph.org | Git project (Linus + maintainers) | p2panda project |
| **Spec maturity** | Stable | Stable | Evolving (NIPs) | Evolving | Stable | Stable | Stable | Stable (W3C Rec) | Alpha/Evolving | Stable (19+ years) | Evolving (v0.x) |
| **Existing network size** | Small (Holochain apps) | Large (Matrix federation) | Large (Nostr relays) | Large (Bluesky + AT network) | Very large (IPFS network) | Small (Solid pods) | Small (Hypercore ecosystem) | Very large (Fediverse) | Small (NextGraph alpha) | Very large (every developer) | Small (p2panda apps) |
| **AD4M links visible to native users** | Yes (Flux) | Yes (as room events) | Yes (kind-1 notes) | Yes (Bluesky posts) | Yes (via gateway) | Yes (as RDF resources) | Partial (via gateway) | Yes (as Notes) | Yes (as SPARQL triples) | Yes (JSON files + `git log`) | Partial (via gateway) |

---

## Expression Languages

Link languages back Perspectives; Expression Languages own URI schemes and resolve URIs in those schemes to `Expression<T>` records. An agent typically installs one Link Language per Neighbourhood and many Expression Languages — every URI scheme an app dereferences needs a registered Expression Language.

|  | literal | language-language | git-expression |
|--|---------|-------------------|----------------|
| **Repo** | Bootstrap (in AD4M) | Bootstrap (in AD4M) | [git-expression-language](https://github.com/coasys/git-expression-language) |
| **Scheme** | `literal://<type>:<value>` | `Qm…` (content-addressed) | `git+https://<host>/<o>/<r>.git#<ref>:<path>` |
| **Provider scope** | Inline (content IS the URI) | Bootstrap CDN | Any Git host (GitHub, GitLab, Gitea, raw HTTP fallback) |
| **Stateless** | ✅ | ✅ (cache only) | ✅ (cache only) |
| **Immutable URIs** | ✅ (always — content addressed) | ✅ (always — content addressed) | When `<ref>` is a SHA |
| **Sub-content addressing** | N/A | N/A | `?lines=`, `?bytes=`, `?jsonpath=`, `?fields=`, `?format=`, `?recursive=` |
| **Tree listings** | N/A | N/A | ✅ (trailing-slash subject) |
| **Verification** | [`verify-expression-literal.sh`](interop/verify-expression-literal.sh) | [`verify-expression-language-language.sh`](interop/verify-expression-language-language.sh) | [`verify-expression-git.sh`](interop/verify-expression-git.sh) |

For building new Expression Languages, see [`coasys/ad4m-expression-language-template`](https://github.com/coasys/ad4m-expression-language-template) — the same scaffolding pattern the Link Language template uses, adapted for `expression: { get, isImmutable, … }`.

---

## Summary: Choosing a Link Language

| If you need... | Use |
|---|---|
| Fully P2P, no infrastructure | **Holochain**, **Hypercore**, **NextGraph**, or **peer2panda** |
| Real-time telepresence (presence, signals) | **Holochain**, **Matrix**, **Nostr**, **IPFS**, or **Hypercore** |
| Human-readable data in native apps | **Matrix**, **Nostr**, **AT Proto**, **Solid**, or **ActivityPub** |
| Sovereign identity (no server authority) | **Holochain**, **Nostr**, **IPFS**, **Hypercore**, **NextGraph**, or **peer2panda** |
| End-to-end encryption | **Matrix** (Olm/Megolm), **Hypercore** (symmetric key), or **NextGraph** (wallet-level) |
| Largest existing network reach | **ActivityPub** (Fediverse) or **Nostr** |
| W3C standards compliance | **Solid** (LDP + RDF) or **ActivityPub** (W3C Rec) |
| Content-addressed / immutable data | **IPFS**, **Holochain**, or **peer2panda** |
| Easiest self-hosting | **Nostr** (single relay) or **Matrix** (Conduit) |
| Bridge to Bluesky / AT network | **AT Protocol** |
| Local-first / offline-capable | **NextGraph** (CRDT), **Git** (local-first; GitHub/Radicle remote), **peer2panda** (append-only log), **Holochain** (partial), or **Hypercore** (partial) |
| Full audit trail + history queries | **Git** (commit DAG + `git-history` / `git-state-at` / `git-blame` queries) |
| Time-travel reads to past states | **Git** (`git-state-at` query) |
| Interoperability with existing developer tooling | **Git** (any Git CLI / GitHub / GitLab / Gitea) |
| Dual-language alongside Holochain | Any of the ALDK languages (all support it) |
