/**
 * Centralized configuration for AD4M Wind Tunnel.
 *
 * All machine-specific values are configurable via environment variables
 * and/or CLI arguments. CLI args take precedence over env vars.
 */

import { tmpdir } from "os";
import { join } from "path";

export type BootstrapMode = "local" | "mainnet" | "holochain";

const BOOTSTRAP_MODES: BootstrapMode[] = ["local", "mainnet", "holochain"];

function normalizeBootstrapMode(raw: string | undefined): BootstrapMode | undefined {
  if (!raw) return undefined;
  const v = raw.toLowerCase();
  if ((BOOTSTRAP_MODES as string[]).includes(v)) return v as BootstrapMode;
  console.error(
    `[config] Unknown bootstrap mode "${raw}" (expected: ${BOOTSTRAP_MODES.join(" | ")}). Falling back to "local".`
  );
  return undefined;
}

/**
 * True for modes that boot the executor against the mainnet seed with
 * Holochain enabled (i.e. current/legacy behaviour). "holochain" is an
 * explicit alias for "mainnet" — same behaviour, clearer intent at the
 * call site for scenarios that specifically need link-language sync.
 */
export function isMainnetBootstrapMode(mode: BootstrapMode): boolean {
  return mode === "mainnet" || mode === "holochain";
}

export interface WindTunnelConfig {
  /** Path to the AD4M repo (for building executor from source) */
  adamRepoPath: string;
  /** Admin token for executor authentication */
  adminToken: string;
  /** Base directory for temporary files (data dirs, build dirs) */
  tmpDirBase: string;
  /** Base port for executor instances */
  basePort: number;
  /** Directory for storing results */
  resultsDir: string;
  /**
   * Which bootstrap seed executors boot against:
   *  - "local"     Local KV-backed bootstrap languages, no Holochain, no
   *                 external network deps (default). The vast majority of
   *                 scenarios never create a neighbourhood or publish a
   *                 language, so they don't need the mainnet seed.
   *  - "mainnet"    Current/legacy behaviour: mainnet seed resolved via the
   *                 Cloudflare Workers bootstrap CDN, p-diff-sync (Holochain)
   *                 as the default link language.
   *  - "holochain"  Alias for "mainnet" — same behaviour, clearer intent.
   */
  bootstrapMode: BootstrapMode;
}

/**
 * Parse CLI arguments for config overrides.
 * Returns only the config-related args; other args (--scenario, --branch, etc.)
 * are handled by the main runner's parseArgs().
 */
function parseConfigArgs(): Partial<WindTunnelConfig> {
  const args = process.argv.slice(2);
  const result: Partial<WindTunnelConfig> = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--ad4m-repo":
        result.adamRepoPath = args[++i];
        break;
      case "--admin-token":
        result.adminToken = args[++i];
        break;
      case "--tmp-dir":
        result.tmpDirBase = args[++i];
        break;
      case "--base-port":
        result.basePort = parseInt(args[++i], 10);
        break;
      case "--results-dir":
        result.resultsDir = args[++i];
        break;
      case "--bootstrap-mode":
        result.bootstrapMode = normalizeBootstrapMode(args[++i]);
        break;
    }
  }

  return result;
}

/**
 * Build the resolved config by merging defaults < env vars < CLI args.
 */
function resolveConfig(): WindTunnelConfig {
  const cliArgs = parseConfigArgs();
  const systemTmp = tmpdir();

  return {
    adamRepoPath:
      cliArgs.adamRepoPath
      ?? process.env.AD4M_REPO
      ?? "",
    adminToken:
      cliArgs.adminToken
      ?? process.env.AD4M_ADMIN_TOKEN
      ?? "test123",
    tmpDirBase:
      cliArgs.tmpDirBase
      ?? process.env.AD4M_WT_TMPDIR
      ?? systemTmp,
    basePort:
      cliArgs.basePort
      ?? (process.env.AD4M_WT_BASE_PORT ? parseInt(process.env.AD4M_WT_BASE_PORT, 10) : 12100),
    resultsDir:
      cliArgs.resultsDir
      ?? process.env.AD4M_WT_RESULTS_DIR
      ?? join(process.cwd(), "results"),
    bootstrapMode:
      cliArgs.bootstrapMode
      ?? normalizeBootstrapMode(process.env.AD4M_WT_BOOTSTRAP_MODE)
      ?? "local",
  };
}

/** Singleton resolved config */
export const config = resolveConfig();

/**
 * Validate that required config values are present.
 * Call this before operations that need the AD4M repo path.
 */
export function validateAdamRepo(): void {
  if (!config.adamRepoPath) {
    console.error(
      "[config] AD4M repo path is required.\n" +
      "  Set via: --ad4m-repo <path>, or AD4M_REPO env var.\n" +
      "  Example: AD4M_REPO=/path/to/ad4m npx tsx src/main.ts"
    );
    process.exit(1);
  }
}
