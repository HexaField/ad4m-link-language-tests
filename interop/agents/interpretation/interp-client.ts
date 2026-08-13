/**
 * Minimal AD4M WS-RPC client for the I-series (Interpretation) scenarios.
 *
 * The interpretation surface (`perspective.runInterpretation`, `addAutoProcessor`,
 * `interpretationOverlays`, `acceptInterpretation`, `rejectInterpretation`) carries
 * no MCP tool — `@coasys/ad4m`'s `PerspectiveProxy` drives it directly, itself a
 * thin wrapper over this exact wire protocol (JSON `{id,type,params}` request /
 * `{id,result}` response over `ws://host:port/api/v1/ws?token=<admin-or-user-jwt>`,
 * confirmed against `core/src/perspectives/PerspectiveClient.ts` and
 * `rust-executor/src/api/perspectives_ws.rs` in the #881 worktree). This file talks
 * that protocol directly rather than depending on `@coasys/ad4m` — the #881
 * worktree's `core` package carries no build output in this environment (and
 * building it stayed out of scope here), so nothing exists yet to resolve the
 * package from.
 *
 * Deliberately self-contained (no shared import from `src/client.ts`): unlike that
 * class, callers here also need unsolicited server-pushed messages — the
 * `auto-processor-event` signal stream `addAutoProcessorEventListener` subscribes
 * to carries no request/response pairing, just a `type` discriminator on a
 * broadcast frame.
 */
import WebSocket from "ws";

export interface TranscriptTurn {
  speaker: string;
  text: string;
}

/** Mirrors `AddAutoProcessorConfig` (core/src/perspectives/AutoProcessor.ts). */
export interface AddAutoProcessorConfig {
  processorId: string;
  sourceScopeQuery: string;
  basePrefix?: string;
  interpretationClasses: string[];
  debounceMs: number;
  batchMin?: number;
  batchMax: number;
  maxWaitMs?: number;
  claimTtlMs: number;
  dedupStrategyJson?: string;
}

/** Mirrors `AutoProcessorEvent` (core/src/perspectives/AutoProcessor.ts). */
export interface AutoProcessorEvent {
  type: "auto-processor-event";
  perspectiveUuid: string;
  processorId: string;
  agentDid?: string;
  step:
    | "batchReady"
    | "claimed"
    | "backedOff"
    | "awaitingAuthor"
    | "notCandidate"
    | "gatheringTranscript"
    | "runningInterpretation"
    | "processed"
    | "shapesMissing"
    | "emptyTranscript";
  itemIds: string[];
  bases: string[];
  detail?: string;
}

/** Mirrors `InterpretationOverlay` (core/src/perspectives/AutoProcessor.ts). */
export interface InterpretationOverlay {
  base: string;
  kind: "create" | "update";
  run: string | null;
  inferred: [string, any][];
}

export interface LinkExpressionLike {
  author?: string;
  timestamp?: string;
  data: { source: string; predicate?: string | null; target: string };
  proof?: any;
}

/**
 * A raw WS-RPC connection to one AD4M executor. `call()` gives an escape hatch
 * for any `perspective.*` / `ai.*` / `agent.*` / `neighbourhood.*` / `language.*`
 * method; the typed helpers below cover everything the I-series scenarios need.
 */
export class InterpClient {
  private ws: WebSocket | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private listeners: Array<(msg: any) => void> = [];

  constructor(
    public readonly host: string,
    public readonly port: number,
    public readonly token: string,
  ) {}

  get wsUrl(): string {
    return `ws://${this.host}:${this.port}/api/v1/ws?token=${encodeURIComponent(this.token)}`;
  }

  async connect(): Promise<void> {
    this.ready = new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.on("open", () => resolve());
      this.ws.on("error", (err) => reject(err));
      this.ws.on("message", (data) => {
        let msg: any;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (msg && msg.id != null) {
          const p = this.pending.get(String(msg.id));
          if (p) {
            this.pending.delete(String(msg.id));
            if (msg.error) p.reject(new Error(typeof msg.error === "string" ? msg.error : JSON.stringify(msg.error)));
            else p.resolve(msg.result);
          }
          return;
        }
        // Unsolicited broadcast (e.g. `auto-processor-event`) — no matching id.
        for (const cb of this.listeners) {
          try {
            cb(msg);
          } catch {
            /* listener errors must not break the socket loop */
          }
        }
      });
      this.ws.on("close", () => {
        for (const [, p] of this.pending) p.reject(new Error("WebSocket closed"));
        this.pending.clear();
      });
    });
    await this.ready;
  }

  close(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* already closed */
      }
      this.ws = null;
    }
  }

  /** Subscribe to every unsolicited broadcast frame; returns an unsubscribe fn. */
  onEvent(cb: (msg: any) => void): () => void {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  async call<T = any>(type: string, params: Record<string, any> = {}, timeoutMs = 60_000): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error(`InterpClient: not connected (call ${type})`);
    const id = String(this.nextId++);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ id, type, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`InterpClient: ${type} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
    });
  }

  // ── perspective lifecycle ──────────────────────────────────────────────

  async createPerspective(name: string): Promise<{ uuid: string; name: string }> {
    return this.call("perspective.create", { name });
  }

  // ── SHACL subject-class registration ───────────────────────────────────

  /** `shaclJson` takes a hand-authored SHACLShape JSON string (see models.ts) —
   * the exact wire contract `PerspectiveProxy.addSdna`/`ensureSubjectClass` use
   * (`core/src/perspectives/PerspectiveProxy.ts`: `JSON.stringify(shape.toJSON())`
   * passed straight through as `shaclJson`). */
  async addSdna(uuid: string, name: string, shaclJson: string): Promise<boolean> {
    return this.call("perspective.addSdna", { uuid, name, sdnaCode: "", sdnaType: "subject_class", shaclJson });
  }

  // ── links ───────────────────────────────────────────────────────────────

  async addLink(
    uuid: string,
    link: { source: string; predicate: string; target: string },
    status: "local" | "shared" = "shared",
  ): Promise<LinkExpressionLike> {
    return this.call("perspective.addLink", { uuid, link, status });
  }

  async queryLinks(
    uuid: string,
    query: { source?: string; predicate?: string; target?: string } = {},
  ): Promise<LinkExpressionLike[]> {
    return this.call("perspective.queryLinks", { uuid, query });
  }

  // ── model-query (typed instance reads) ─────────────────────────────────

  /** `query` mirrors the Rust `model_query` DSL, e.g. `{}` for "all instances",
   * `{"properties":["title","owner"]}` to select fields. */
  async modelQuery(uuid: string, className: string, query: Record<string, any> = {}): Promise<{ instances: any[]; totalCount: number }> {
    return this.call("perspective.modelQuery", { uuid, class_name: className, query_json: JSON.stringify(query) });
  }

  // ── scalar property write (mirrors a single-valued `setSingleTarget` setter) ──

  /**
   * Overwrite a single-valued scalar property through the SAME action-execution
   * primitive `Ad4mModel.save()`/`update()` uses under the hood
   * (`perspective.executeCommands`), rather than hand-rolling link removal —
   * this captures what a "human edits a value through the client" step means at
   * the wire level. `predicate` must name the property's real predicate (the SDNA
   * `path`, e.g. `wt://owner`), and the class's SDNA must declare it with a
   * `setSingleTarget` setter (see models.ts).
   */
  async setScalarProperty(uuid: string, base: string, predicate: string, value: string): Promise<void> {
    const commands = JSON.stringify([{ action: "setSingleTarget", source: "this", predicate, target: "value" }]);
    const parameters = JSON.stringify([{ name: "value", value }]);
    await this.call("perspective.executeCommands", { uuid, commands, expression: base, parameters });
  }

  // ── AI model registration ──────────────────────────────────────────────

  /** Wire shape mirrors `AIClient.addModel`'s `serializeModelInput` — this call
   * alone renames `modelType` to `type` inside the `model` object. */
  async addModel(model: {
    name: string;
    modelType: "LLM" | "EMBEDDING" | "TRANSCRIPTION";
    api: { baseUrl: string; apiKey: string; model: string; apiType: "OPEN_AI" };
  }): Promise<string> {
    const { modelType, ...rest } = model;
    return this.call("ai.addModel", { model: { ...rest, type: modelType } });
  }

  /** Unlike `addModel`, `setDefaultModel`'s wire params keep `modelType` (no
   * rename) — confirmed against `AIClient.setDefaultModel`. */
  async setDefaultModel(modelType: "LLM" | "EMBEDDING" | "TRANSCRIPTION", modelId: string): Promise<boolean> {
    return this.call("ai.setDefaultModel", { id: modelId, modelType });
  }

  // ── generic-LLM-interpretation surface ─────────────────────────────────

  async runInterpretation(uuid: string, transcript: TranscriptTurn[], basePrefix: string, classes?: string[]): Promise<string[]> {
    return this.call("perspective.runInterpretation", { uuid, transcript, basePrefix, classes }, 120_000);
  }

  async addAutoProcessor(uuid: string, config: AddAutoProcessorConfig): Promise<string> {
    return this.call("perspective.addAutoProcessor", { uuid, ...config });
  }

  async interpretationOverlays(uuid: string): Promise<InterpretationOverlay[]> {
    return this.call("perspective.interpretationOverlays", { uuid });
  }

  async acceptInterpretation(uuid: string, base: string, property?: string): Promise<boolean> {
    return this.call("perspective.acceptInterpretation", { uuid, base, property });
  }

  async rejectInterpretation(uuid: string, base: string, property?: string): Promise<boolean> {
    return this.call("perspective.rejectInterpretation", { uuid, base, property });
  }

  /** Registers a listener for every `auto-processor-event` broadcast; returns an
   * unsubscribe fn. This does not filter events for OTHER perspectives/processors —
   * callers narrow on `perspectiveUuid`/`processorId` themselves. */
  onAutoProcessorEvent(cb: (ev: AutoProcessorEvent) => void): () => void {
    return this.onEvent((msg) => {
      if (msg && msg.type === "auto-processor-event") cb(msg as AutoProcessorEvent);
    });
  }

  // ── neighbourhood (best-effort, I6 only) ───────────────────────────────

  async publishLanguage(languagePath: string, languageMeta: Record<string, any>): Promise<{ address: string }> {
    return this.call("language.publish", { languagePath, languageMeta });
  }

  async applyTemplateAndPublish(sourceLanguageHash: string, templateData: string): Promise<{ address: string }> {
    return this.call("language.applyTemplate", { sourceLanguageHash, templateData });
  }

  async publishNeighbourhood(perspectiveUuid: string, linkLanguage: string, meta: { links: any[] } = { links: [] }): Promise<string> {
    return this.call("neighbourhood.publish", { perspectiveUuid, linkLanguage, meta });
  }

  async joinFromUrl(url: string): Promise<{ uuid: string; name: string }> {
    return this.call("neighbourhood.joinFromUrl", { url }, 120_000);
  }
}

/** Poll the executor's plain HTTP root until it answers (matches the
 * `docker-entrypoint.sh` readiness probe, `curl -sf http://localhost:12000/`).
 * The entrypoint's own `maybe_setup_agent()` (agent generate/unlock — needed
 * before wallet-dependent RPCs like JWT-signing will work) runs AFTER that
 * probe first succeeds, so a short grace margin follows before returning. */
export async function waitForExecutorHealth(host: string, port: number, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(3000) });
      if (res.ok || res.status < 500) {
        await sleep(8_000);
        return;
      }
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`executor at ${host}:${port} did not become healthy within ${timeoutMs}ms: ${lastErr}`);
}

/** Poll the mock LLM's `/health` endpoint. */
export async function waitForMockHealth(host: string, port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`mock LLM at ${host}:${port} did not become healthy within ${timeoutMs}ms: ${lastErr}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Register a deterministic interpretation LLM pointed at the mock and make it
 * the executor's default LLM — the same two calls
 * `tests/js/tests/model/run-interpretation.test.ts` and
 * `auto-processor.test.ts` make (`ad4m.ai.addModel` + `ad4m.ai.setDefaultModel`).
 * `ensure_interpretation_task`'s DB row binds to model_id `"default"`, which
 * `AIService::replace_model_variables` resolves to whichever model holds the
 * default-LLM slot — so no separate per-task model wiring matters; setting the
 * default suffices (confirmed in `rust-executor/src/ai_service/mod.rs`).
 */
export async function registerInterpretationModel(
  client: InterpClient,
  mockHost: string,
  mockPort: number,
  modelName = "interp-mock",
): Promise<string> {
  const modelId = await client.addModel({
    name: modelName,
    modelType: "LLM",
    api: { baseUrl: `http://${mockHost}:${mockPort}/v1`, apiKey: "sk-mock", model: "mock-interp", apiType: "OPEN_AI" },
  });
  await client.setDefaultModel("LLM", modelId);
  return modelId;
}
