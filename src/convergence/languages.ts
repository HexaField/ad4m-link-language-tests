/**
 * Convergence-language registry for the c1 multi-agent scenario.
 *
 * Each entry describes how to install one AD4M link language into two
 * executors and (optionally) the native backend it needs live. c1 templates
 * the bundle with `makeTemplateData(neighbourhoodId)`, publishes a
 * neighbourhood on agent A, joins from agent B, and asserts the two agents'
 * link sets converge over the real backend.
 *
 * Only fully-specified, runnable entries belong here. A backend that cannot be
 * brought up is recorded as "not reachable" at run time — never faked.
 */

import { resolve } from "path";
import { createHash } from "crypto";
import { provisionMatrix, provisionAtproto } from "./provision.js";

/** Deterministic 32-byte hex digest of a string (e.g. a shared hypercore key). */
function hex32(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

/** Coasys workspace root — parent of the wind-tunnel checkout by default. */
const WORKSPACE_ROOT = process.env.CONVERGENCE_WORKSPACE_ROOT || resolve(process.cwd(), "..");

/**
 * Solid (Community Solid Server) endpoint — env-configurable so CSS can run on a
 * free port when :3000 is occupied by another local service. The language bundle
 * and the health probe must agree with the port the compose file binds, so all
 * three read the same two vars: SOLID_PORT and SOLID_BASE_URL.
 */
const SOLID_PORT = parseInt(process.env.SOLID_PORT || "3000", 10);
const SOLID_BASE_URL = process.env.SOLID_BASE_URL || `http://127.0.0.1:${SOLID_PORT}`;

export interface BackendHealth {
  /** docker-compose file under infra/ that brings the backend up. */
  compose: string;
  /** TCP host:port to probe for readiness (relays, PDS, homeservers). */
  healthTcp?: { host: string; port: number };
  /** HTTP URL to probe for readiness (2xx/4xx answered => reachable). */
  healthUrl?: string;
}

export interface ConvergenceLanguage {
  id: string;
  /** Absolute path to the built language bundle (esbuild output). */
  bundlePath: string;
  /** Template-variable names declared in the bundle (informational for publish). */
  possibleTemplateParams: string[];
  /** Native backend this language rides; omit for backend-less languages. */
  backend?: BackendHealth;
  /**
   * Produce the template map A uses to instantiate a shared language for a
   * fresh neighbourhood id. Values are JSON-encoded into the bundle by the
   * executor (`serde_json::to_string`), so pass JS strings — a JSON array is
   * itself passed as its stringified form when the bundle re-parses it.
   * Both agents resolve the SAME templated address, so values must be
   * deterministic for a given neighbourhood id.
   */
  makeTemplateData(neighbourhoodId: string): Record<string, string>;
  /**
   * Optional async provisioning, run ONCE per C1 run after the backend health
   * check and before templating. Creates any live account/room/repo the backend
   * needs (a Matrix user + room, an AT Proto account) and returns extra template
   * variables merged OVER `makeTemplateData`'s output. Throwing aborts the run as
   * an honest skip (never a faked pass). Omit for backends addressable from the
   * neighbourhood id alone (nostr, ipfs, solid, …).
   */
  provision?(neighbourhoodId: string): Promise<Record<string, string>>;
}

/**
 * Shared nostr keypair (schnorr / BIP-340). Both agents template the same
 * language, so they sign kind-9078 diff events with the same key. Convergence
 * still holds: the diff-DAG folds by event id (e-tag parents) and the OR-Set
 * keys by link hash; the kind-9078 ingest path has no pubkey filter. Pubkey
 * echo-suppression is Channel-B (kind-1 notes) only. `NOSTR_PUBKEY` is the
 * x-only schnorr pubkey of `NOSTR_PRIVKEY` (verified: getPublicKey round-trip).
 */
const NOSTR_PRIVKEY = "19a9195a85f6aae3214da4a226b25efa1367ece744bc499f60fbee780303af82";
const NOSTR_PUBKEY = "064a6bf3e959379b7ecf026354af5295439f8f525def6102b946251e09741149";

export const CONVERGENCE_LANGUAGES: ConvergenceLanguage[] = [
  {
    id: "nostr",
    bundlePath: resolve(WORKSPACE_ROOT, "nostr-link-language/build/bundle.js"),
    possibleTemplateParams: [
      "NOSTR_RELAY_URLS",
      "NOSTR_NEIGHBOURHOOD_ID",
      "NOSTR_PUBKEY",
      "NOSTR_PRIVKEY",
      "NEIGHBOURHOOD_META",
    ],
    backend: {
      compose: "docker-compose.nostr.yml",
      healthTcp: { host: "127.0.0.1", port: 7777 },
    },
    makeTemplateData(neighbourhoodId: string): Record<string, string> {
      return {
        // Re-parsed by the bundle via JSON.parse, so pass the array's JSON text.
        NOSTR_RELAY_URLS: JSON.stringify(["ws://127.0.0.1:7777"]),
        NOSTR_NEIGHBOURHOOD_ID: neighbourhoodId,
        NOSTR_PUBKEY,
        NOSTR_PRIVKEY,
        NEIGHBOURHOOD_META: "{}",
      };
    },
  },

  {
    // IPFS (Kubo) — diff-DAG blocks addressed by CID, heads announced over
    // pubsub. NEIGHBOURHOOD_URL is the per-neighbourhood pubsub topic both
    // agents subscribe to; only IPFS_API_URL is strictly required to connect.
    id: "ipfs",
    bundlePath: resolve(WORKSPACE_ROOT, "ipfs-link-language/build/bundle.js"),
    possibleTemplateParams: [
      "IPFS_API_URL",
      "IPFS_GATEWAY_URL",
      "IPNS_NAME",
      "PINNING_SERVICE_URL",
      "NEIGHBOURHOOD_META",
      "NEIGHBOURHOOD_URL",
    ],
    backend: {
      compose: "docker-compose.ipfs.yml",
      healthTcp: { host: "127.0.0.1", port: 5001 },
    },
    makeTemplateData(neighbourhoodId: string): Record<string, string> {
      return {
        IPFS_API_URL: "http://127.0.0.1:5001",
        IPFS_GATEWAY_URL: "http://127.0.0.1:8080",
        NEIGHBOURHOOD_URL: `neighbourhood://${neighbourhoodId}`,
        NEIGHBOURHOOD_META: "{}",
      };
    },
  },

  {
    // Solid (Community Solid Server) — diff-commit DAG as LDP resources under a
    // shared container. Both agents write the same container path; convergence
    // rides GET/PUT of content-hashed resources.
    id: "solid",
    bundlePath: resolve(WORKSPACE_ROOT, "solid-link-language/build/bundle.js"),
    possibleTemplateParams: [
      "SOLID_POD_URL",
      "SOLID_CONTAINER_PATH",
      "SOLID_IDP_URL",
      "SOLID_WEBID",
      "NEIGHBOURHOOD_META",
    ],
    backend: {
      compose: "docker-compose.solid.yml",
      healthTcp: { host: "127.0.0.1", port: SOLID_PORT },
    },
    makeTemplateData(neighbourhoodId: string): Record<string, string> {
      return {
        SOLID_POD_URL: SOLID_BASE_URL,
        SOLID_CONTAINER_PATH: `ad4m/${neighbourhoodId}/`,
        NEIGHBOURHOOD_META: "{}",
      };
    },
  },

  {
    // NextGraph — native CRDT store fronted by a Node sidecar gateway (WASM).
    // NEXTGRAPH_REPO_ID is the shared repo/store id both agents open.
    id: "nextgraph",
    bundlePath: resolve(WORKSPACE_ROOT, "nextgraph-link-language/build/bundle.js"),
    possibleTemplateParams: ["NEXTGRAPH_GATEWAY_URL", "NEXTGRAPH_REPO_ID", "NEIGHBOURHOOD_META"],
    backend: {
      compose: "gateway (nextgraph-link-language/gateway, npm start on :7779)",
      healthTcp: { host: "127.0.0.1", port: 7779 },
    },
    makeTemplateData(neighbourhoodId: string): Record<string, string> {
      return {
        NEXTGRAPH_GATEWAY_URL: "http://127.0.0.1:7779",
        NEXTGRAPH_REPO_ID: neighbourhoodId,
        NEIGHBOURHOOD_META: "{}",
      };
    },
  },

  {
    // peer2panda — p2panda gossip over a Rust sidecar gateway (iroh transport).
    // PEER2PANDA_TOPIC_ID is the shared gossip topic both agents subscribe to.
    id: "peer2panda",
    bundlePath: resolve(WORKSPACE_ROOT, "peer2panda-link-language/build/bundle.js"),
    possibleTemplateParams: ["PEER2PANDA_GATEWAY_URL", "PEER2PANDA_TOPIC_ID", "NEIGHBOURHOOD_META"],
    backend: {
      compose: "gateway (peer2panda-link-language/gateway, cargo run --release on :7780)",
      healthTcp: { host: "127.0.0.1", port: 7780 },
    },
    makeTemplateData(neighbourhoodId: string): Record<string, string> {
      return {
        PEER2PANDA_GATEWAY_URL: "http://127.0.0.1:7780",
        PEER2PANDA_TOPIC_ID: neighbourhoodId,
        NEIGHBOURHOOD_META: "{}",
      };
    },
  },

  {
    // Hypercore — Autobase multi-writer fronted by a Node sidecar gateway.
    // Both agents MUST open the SAME base: template a deterministic shared
    // 32-byte key (never "auto", which would fork two independent bases).
    id: "hypercore",
    bundlePath: resolve(WORKSPACE_ROOT, "hypercore-link-language/build/bundle.js"),
    possibleTemplateParams: [
      "HYPERCORE_KEY",
      "DISCOVERY_KEY",
      "BOOTSTRAP_NODES",
      "NEIGHBOURHOOD_META",
      "HYPERCORE_GATEWAY_URL",
    ],
    backend: {
      compose: "gateway (hypercore-link-language/gateway, npm start on :7790)",
      healthTcp: { host: "127.0.0.1", port: 7790 },
    },
    makeTemplateData(neighbourhoodId: string): Record<string, string> {
      return {
        HYPERCORE_GATEWAY_URL: "http://127.0.0.1:7790",
        HYPERCORE_KEY: hex32(neighbourhoodId),
        NEIGHBOURHOOD_META: "{}",
      };
    },
  },

  {
    // Matrix (Conduit homeserver) — links are `dev.ad4m.link` state events keyed
    // by link hash; merge is Matrix state-resolution. Both agents share one
    // provisioned user + access token + room (see provisionMatrix), so the
    // provisioning step supplies USER_ID / ACCESS_TOKEN / ROOM_ID at run time.
    id: "matrix",
    bundlePath: resolve(WORKSPACE_ROOT, "matrix-link-language/build/bundle.js"),
    possibleTemplateParams: [
      "MATRIX_HOMESERVER_URL",
      "MATRIX_ROOM_ID",
      "MATRIX_USER_ID",
      "MATRIX_ACCESS_TOKEN",
      "MATRIX_ROOM_ALIAS",
      "NEIGHBOURHOOD_META",
    ],
    backend: {
      compose: "docker-compose.matrix.yml",
      healthTcp: { host: "127.0.0.1", port: 6167 },
    },
    provision: provisionMatrix,
    makeTemplateData(_neighbourhoodId: string): Record<string, string> {
      // The load-bearing values (homeserver, user, token, room) come from
      // provision(); only the static default is set here.
      return { NEIGHBOURHOOD_META: "{}" };
    },
  },

  {
    // AT Proto (Bluesky PDS) — additions are `ad4m.link.triple` records, removals
    // `ad4m.link.tombstone`, riding the repo's MST commit chain. Both agents share
    // one provisioned account (DID + app password) from provisionAtproto.
    id: "atproto",
    bundlePath: resolve(WORKSPACE_ROOT, "atproto-link-language/build/bundle.js"),
    possibleTemplateParams: [
      "AT_PDS_URL",
      "AT_RELAY_URL",
      "AT_DID",
      "AT_HANDLE",
      "AT_COLLECTION_NSID",
      "AT_APP_PASSWORD",
      "NEIGHBOURHOOD_META",
    ],
    backend: {
      compose: "docker-compose.atproto.yml",
      healthTcp: { host: "127.0.0.1", port: 2583 },
    },
    provision: provisionAtproto,
    makeTemplateData(_neighbourhoodId: string): Record<string, string> {
      // PDS URL, DID, handle, and app password come from provision().
      return { NEIGHBOURHOOD_META: "{}" };
    },
  },
];

export function getConvergenceLanguage(id: string): ConvergenceLanguage | undefined {
  return CONVERGENCE_LANGUAGES.find((l) => l.id === id);
}
