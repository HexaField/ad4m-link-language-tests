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

/** Coasys workspace root — parent of the wind-tunnel checkout by default. */
const WORKSPACE_ROOT = process.env.CONVERGENCE_WORKSPACE_ROOT || resolve(process.cwd(), "..");

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
];

export function getConvergenceLanguage(id: string): ConvergenceLanguage | undefined {
  return CONVERGENCE_LANGUAGES.find((l) => l.id === id);
}
