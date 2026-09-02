/**
 * Executor Lifecycle Manager
 * Handles building, starting, stopping, and health-checking AD4M executor instances.
 */

import { spawn, ChildProcess, execSync } from "child_process";
import { mkdirSync, existsSync, writeFileSync, rmSync, readFileSync, copyFileSync, statSync, readdirSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import WebSocket from "ws";
import { config as windTunnelConfig, isMainnetBootstrapMode, type BootstrapMode } from "./config.js";

// ── Local bootstrap seed ────────────────────────────────────────────────
// Most scenarios never create a neighbourhood or publish a language, so
// booting them against the mainnet seed (Cloudflare Workers bootstrap CDN +
// Holochain p-diff-sync as the default link language) buys nothing but a
// slower, network-dependent Holochain conductor startup. `--bootstrap-mode
// local` (the default — see src/config.ts) instead seeds executors with the
// KV-backed local bootstrap languages from `bootstrap/` and skips Holochain
// entirely (`--run-holochain false`). Only scenarios that genuinely test
// link-language sync (c1, s9 in holochain mode) override back to mainnet —
// see the per-scenario override in main.ts.

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), "..");
const LOCAL_BOOTSTRAP_OUT_DIR = join(REPO_ROOT, "dist", "bootstrap");

/**
 * Resolve the local bootstrap language source directory from the AD4M repo.
 * These live at `<adamRepoPath>/bootstrap-languages/local/` — the paired
 * AD4M PR (#893) puts them there. No duplicate copy in the wind tunnel.
 */
function localBootstrapSrcDir(adamRepoPath?: string): string {
  const repo = adamRepoPath || windTunnelConfig.adamRepoPath;
  if (!repo) {
    throw new Error(
      "AD4M repo path required for local bootstrap mode. " +
      "Set via --ad4m-repo or AD4M_REPO, or use --bootstrap-mode mainnet."
    );
  }
  return join(repo, "bootstrap-languages", "local");
}

export interface LocalBootstrapSeed {
  /** Path to the generated docker_seed.json (passed as --network-bootstrap-seed) */
  seedPath: string;
  /** Directory of `<language-hash>/bundle.js` dirs to pre-populate into each data dir */
  languagesDir: string;
  /** Content address of the local language-language bundle */
  kvAddress: string;
  /** Pre-built language-language KV store (meta + bundle entries for the other 5 languages) */
  kvFile: string;
}

let cachedLocalSeed: LocalBootstrapSeed | null = null;

/**
 * Generate (or reuse a cached) local bootstrap seed from `bootstrap/` into
 * `dist/bootstrap/`. Idempotent — safe to call once up front (main.ts) and
 * again lazily from any executor start; only regenerates when the output
 * markers are missing.
 */
export function ensureLocalBootstrapSeed(adamRepoPath?: string): LocalBootstrapSeed {
  if (cachedLocalSeed) return cachedLocalSeed;

  const seedPath = join(LOCAL_BOOTSTRAP_OUT_DIR, "docker_seed.json");
  const kvAddressPath = join(LOCAL_BOOTSTRAP_OUT_DIR, "language-language-kv", "address.txt");

  if (!existsSync(seedPath) || !existsSync(kvAddressPath)) {
    const srcDir = localBootstrapSrcDir(adamRepoPath);
    if (!existsSync(srcDir)) {
      throw new Error(
        `Local bootstrap sources not found at ${srcDir}. ` +
        `Ensure the AD4M repo (--ad4m-repo) contains bootstrap-languages/local/, ` +
        `or use --bootstrap-mode mainnet.`
      );
    }
    console.log(`[executor] Generating local bootstrap seed from ${srcDir} into ${LOCAL_BOOTSTRAP_OUT_DIR}...`);
    mkdirSync(LOCAL_BOOTSTRAP_OUT_DIR, { recursive: true });
    execSync(
      `node "${join(srcDir, "generate-seed.mjs")}" "${srcDir}" "${LOCAL_BOOTSTRAP_OUT_DIR}"`,
      { stdio: "pipe", timeout: 30000 }
    );
  }

  cachedLocalSeed = {
    seedPath,
    languagesDir: join(LOCAL_BOOTSTRAP_OUT_DIR, "languages"),
    kvAddress: readFileSync(kvAddressPath, "utf8").trim(),
    kvFile: join(LOCAL_BOOTSTRAP_OUT_DIR, "language-language-kv", "ad4m-language-kv.json"),
  };
  return cachedLocalSeed;
}

/**
 * Pre-populate a freshly-init'd data directory with the local bootstrap
 * language bundles and the language-language's KV store, mirroring the
 * Docker entrypoint's pre-seeding logic (docker-entrypoint.sh in the AD4M
 * repo). Without this, the local language-language resolves other system
 * languages via `storageGet`, which finds nothing right after a bare `init`.
 */
function populateLocalLanguageBundles(dataPath: string, seed: LocalBootstrapSeed): void {
  const languagesTarget = join(dataPath, "ad4m", "languages");

  for (const hash of readdirSync(seed.languagesDir)) {
    const hashDir = join(seed.languagesDir, hash);
    const bundleSrc = join(hashDir, "bundle.js");
    if (!statSync(hashDir).isDirectory() || !existsSync(bundleSrc)) continue;
    const target = join(languagesTarget, hash);
    mkdirSync(target, { recursive: true });
    copyFileSync(bundleSrc, join(target, "bundle.js"));
  }

  const kvTarget = join(languagesTarget, seed.kvAddress);
  mkdirSync(kvTarget, { recursive: true });
  copyFileSync(seed.kvFile, join(kvTarget, "ad4m-language-kv.json"));
}

/**
 * The snapshot is determined by whichever `deno_runtime` git revision is
 * resolved by `Cargo.lock`. Cache it keyed by that revision so subsequent
 * branches with the same Deno pin reuse the same bytes, and so multi-branch
 * comparison runs only pay the snapshot cost once per Deno version.
 */
function snapshotCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const dir = join(base, "ad4m-wind-tunnel", "deno-snapshots");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Parse the resolved git revision for `deno_runtime` from a Cargo.lock file. */
function denoRuntimeRevision(buildDir: string): string | null {
  const lockPath = join(buildDir, "Cargo.lock");
  if (!existsSync(lockPath)) return null;
  const lock = readFileSync(lockPath, "utf8");
  // Each [[package]] block is small; find the one named deno_runtime and
  // pull the trailing `#<sha>` from its `source = "git+...#<sha>"` line.
  const match = lock.match(
    /\[\[package\]\][\s\S]*?name\s*=\s*"deno_runtime"[\s\S]*?source\s*=\s*"git\+[^"#]+#([0-9a-f]+)"/
  );
  return match ? match[1] : null;
}

function snapshotIsValid(p: string): boolean {
  // Empty file = stub seed; treat as invalid so we always regen on miss.
  return existsSync(p) && statSync(p).size > 0;
}

export interface ExecutorConfig {
  branch: string;
  port: number;
  dataPath: string;
  adminToken: string;
  adamRepoPath: string;
  buildDir: string;
  /** Extra CLI args appended to the `run` invocation (e.g. ["--language-language-only","true"]). */
  extraArgs?: string[];
  /**
   * Overrides the global `--bootstrap-mode` default for this executor.
   * Falls back to the resolved config's `bootstrapMode` when omitted, so
   * scenarios that start additional executors on their own (c1, m2, m4, m5)
   * without setting this inherit whatever mode main.ts put in effect for
   * the scenario's run.
   */
  bootstrapMode?: BootstrapMode;
}

export interface ExecutorInstance {
  config: ExecutorConfig;
  process: ChildProcess | null;
  binaryPath: string;
  buildDurationMs: number;
  startDurationMs: number;
}

export async function buildExecutor(config: ExecutorConfig): Promise<string> {
  const { branch, buildDir, adamRepoPath } = config;

  console.log(`[executor] Building branch: ${branch} in ${buildDir}`);

  if (existsSync(buildDir)) {
    rmSync(buildDir, { recursive: true, force: true });
  }

  execSync(
    `git clone --depth 1 --branch ${branch} --single-branch "${adamRepoPath}" "${buildDir}"`,
    { stdio: "pipe", timeout: 60000 }
  );

  // Ensure dapp/dist placeholder exists
  const dappDir = join(buildDir, "dapp", "dist");
  mkdirSync(dappDir, { recursive: true });
  if (!existsSync(join(dappDir, "index.html"))) {
    writeFileSync(join(dappDir, "index.html"), "<!DOCTYPE html><html><body></body></html>");
  }

  // `CUSTOM_DENO_SNAPSHOT.bin` is consumed by `include_bytes!` in
  // `js_core/options.rs`, so the file must exist at compile time. Its content
  // also has to match the linked `deno_runtime`'s V8 — a mismatch causes the
  // executor to panic at language-runtime init with
  // `Check failed: magic_number_ == SerializedData::kMagicNumber`.
  //
  // The snapshot is fully determined by whichever `deno_runtime` git
  // revision the branch's `Cargo.lock` resolves to, so we cache it keyed by
  // that revision under `$XDG_CACHE_HOME/ad4m-wind-tunnel/deno-snapshots/`.
  // Multi-branch runs whose Cargo.lock all point at the same Deno commit
  // pay the snapshot cost once and copy thereafter.
  const snapshotRootPath = join(buildDir, "CUSTOM_DENO_SNAPSHOT.bin");
  const snapshotRustExecutorPath = join(buildDir, "rust-executor", "CUSTOM_DENO_SNAPSHOT.bin");

  const denoRev = denoRuntimeRevision(buildDir);
  const cachePath = denoRev
    ? join(snapshotCacheDir(), `${denoRev}.bin`)
    : null;

  // Copy schema.gql if needed (must precede `cargo run`, which compiles core/).
  const schemaSrc = join(adamRepoPath, "core", "lib", "src", "schema.gql");
  if (existsSync(schemaSrc)) {
    const schemaTarget = join(buildDir, "core", "lib", "src");
    mkdirSync(schemaTarget, { recursive: true });
    execSync(`cp "${schemaSrc}" "${join(schemaTarget, "schema.gql")}"`, { stdio: "pipe" });
  }

  if (cachePath && snapshotIsValid(cachePath)) {
    console.log(`[executor] Using cached snapshot for deno_runtime ${denoRev!.slice(0, 12)}`);
    copyFileSync(cachePath, snapshotRootPath);
    copyFileSync(cachePath, snapshotRustExecutorPath);
  } else {
    // Seed a stub so `include_bytes!` compiles the snapshot generator, then
    // run the generator to write real bytes against the build's own deno deps.
    writeFileSync(snapshotRootPath, "");
    writeFileSync(snapshotRustExecutorPath, "");
    console.log(
      cachePath
        ? `[executor] Generating snapshot for deno_runtime ${denoRev!.slice(0, 12)}...`
        : `[executor] Generating snapshot (Cargo.lock deno_runtime revision unresolved)...`
    );
    execSync("cargo run --release --bin generate_snapshot 2>&1", {
      cwd: join(buildDir, "rust-executor"),
      stdio: "pipe",
      timeout: 1800000,
    });
    copyFileSync(snapshotRustExecutorPath, snapshotRootPath);
    if (cachePath) {
      copyFileSync(snapshotRustExecutorPath, cachePath);
      console.log(`[executor] Cached snapshot at ${cachePath}`);
    }
  }

  // Build the executor
  console.log(`[executor] Building ad4m-executor for ${branch}...`);
  execSync("cargo build --release --bin ad4m-executor 2>&1", {
    cwd: buildDir,
    stdio: "pipe",
    timeout: 1800000, // 30 min
  });

  const binaryPath = join(buildDir, "target", "release", "ad4m-executor");
  if (!existsSync(binaryPath)) {
    throw new Error(`Binary not found at ${binaryPath}`);
  }

  console.log(`[executor] Build complete: ${binaryPath}`);
  return binaryPath;
}

export async function initExecutor(
  binaryPath: string,
  dataPath: string,
  bootstrapMode: BootstrapMode = windTunnelConfig.bootstrapMode
): Promise<void> {
  // Clean data directory
  if (existsSync(dataPath)) {
    rmSync(dataPath, { recursive: true, force: true });
  }
  mkdirSync(dataPath, { recursive: true });

  console.log(`[executor] Initializing data at ${dataPath}...`);

  if (isMainnetBootstrapMode(bootstrapMode)) {
    // Current/legacy behaviour: mainnet seed baked into the binary.
    execSync(`"${binaryPath}" init --data-path "${dataPath}" 2>&1`, {
      stdio: "pipe",
      timeout: 30000,
    });
    return;
  }

  // Local mode: seed with the local KV-backed bootstrap languages, then
  // pre-populate the language bundles + language-language KV store so
  // system language resolution never needs to reach out anywhere.
  const seed = ensureLocalBootstrapSeed();
  execSync(
    `"${binaryPath}" init --data-path "${dataPath}" --network-bootstrap-seed "${seed.seedPath}" 2>&1`,
    { stdio: "pipe", timeout: 30000 }
  );
  populateLocalLanguageBundles(dataPath, seed);
}

export async function startExecutor(
  binaryPath: string,
  config: ExecutorConfig
): Promise<ChildProcess> {
  const bootstrapMode = config.bootstrapMode ?? windTunnelConfig.bootstrapMode;

  // Initialize if needed
  await initExecutor(binaryPath, config.dataPath, bootstrapMode);

  console.log(`[executor] Starting on port ${config.port}, data: ${config.dataPath} (bootstrap: ${bootstrapMode})`);

  const proc = spawn(binaryPath, [
    "run",
    "--app-data-path", config.dataPath,
    "--port", String(config.port),
    "--admin-credential", config.adminToken,
    "--run-dapp-server", "false",
    "--hc-use-bootstrap", "false",
    "--hc-use-proxy", "false",
    "--enable-multi-user", "true",
    ...(isMainnetBootstrapMode(bootstrapMode) ? [] : ["--run-holochain", "false"]),
    ...(config.extraArgs ?? []),
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, RUST_LOG: "info" },
  });

  proc.stdout?.on("data", (d) => {
    const line = d.toString().trim();
    if (line && process.env.VERBOSE) console.log(`[exec:${config.port}:out] ${line}`);
  });
  proc.stderr?.on("data", (d) => {
    const line = d.toString().trim();
    if (line && process.env.VERBOSE) console.log(`[exec:${config.port}:err] ${line}`);
  });

  return proc;
}

export async function waitForHealth(
  port: number,
  timeoutMs: number = 60000,
  adminToken: string = "test123"
): Promise<number> {
  const start = performance.now();
  const deadline = start + timeoutMs;

  const healthUrl = `http://127.0.0.1:${port}/health`;

  while (performance.now() < deadline) {
    try {
      const res = await fetch(healthUrl);
      if (res.ok) {
        // Also verify WS endpoint is accepting connections
        const wsReady = await checkWsReady(port, adminToken, 5000).catch(() => false);
        if (!wsReady) {
          await sleep(500);
          continue;
        }
        return performance.now() - start;
      }
    } catch {}
    await sleep(500);
  }

  throw new Error(`Executor on port ${port} did not become healthy within ${timeoutMs}ms`);
}

async function checkWsReady(port: number, token: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws?token=${token}`);
    const timer = setTimeout(() => { ws.close(); resolve(false); }, timeoutMs);
    ws.on("open", () => {
      // Send a lightweight RPC call to verify the executor is actually ready
      const id = "health-check-1";
      ws.send(JSON.stringify({ id, type: "agent.status", params: {} }));
    });
    ws.on("message", (data: any) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === "health-check-1") {
          clearTimeout(timer);
          ws.close();
          resolve(true);
        }
      } catch {}
    });
    ws.on("error", () => { clearTimeout(timer); ws.close(); resolve(false); });
  });
}

export function stopExecutor(proc: ChildProcess): void {
  if (proc && !proc.killed) {
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
    }, 5000);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
