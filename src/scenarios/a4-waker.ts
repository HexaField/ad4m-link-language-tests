/**
 * A4 — Waker.
 *
 * Proves the @coasys/openclaw-ad4m waker integration surface end-to-end: a live
 * AD4M perspective subscription detects new channel messages and wakes the agent
 * through OpenClaw's REAL /hooks/wake endpoint (real Bearer-token auth, no stub
 * sink). The driver exercises the plugin's OWN WakerSubscriptionManager + postWake
 * and @coasys/ad4m's Ad4mClient + QuerySubscriptionProxy — production plugin code,
 * driven exactly as the plugin's unit tests drive it — against a containerised
 * multi-user node and a real OpenClaw gateway.
 *
 * Asserts: 1 msg -> 1 wake; 3 rapid msgs -> coalesced to 1 wake (debounce dedup);
 * a later msg -> 1 more wake; every wake reaches the real hook (2xx), zero fails.
 *
 * Pod-managed (`managesOwnEnvironment`): the self-contained, hardened verify
 * script stands up its Docker pod (node + mock LLM + real OpenClaw gateway), runs
 * the waker driver, and tears the pod down. Nothing touches the host OS. SKIPs
 * honestly when no dist-built plugin is available (set AD4M_PLUGIN_DIR).
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";

const REPO = process.cwd(); // run.sh invokes the runner from the repo root
const SCRIPT = "interop/agents/verify-a4-waker.sh";

export const a4Waker: Scenario = {
  id: "a4",
  name: "Waker (OpenClaw)",
  description:
    "The @coasys/openclaw-ad4m waker detects new AD4M channel messages via a live perspective subscription and wakes the agent through OpenClaw's real /hooks/wake endpoint: single-message wake, debounce coalescing of a rapid burst, liveness, and real-hook delivery. Self-managed, hardened Docker pod.",
  managesOwnEnvironment: true,

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];
    const metrics: Record<string, any> = {};
    const scriptPath = join(REPO, SCRIPT);

    let out = "";
    let status: "pass" | "skip" | "fail";
    const t0 = performance.now();
    if (!existsSync(scriptPath)) {
      status = "skip";
      metrics.reason = "verify script not present";
    } else {
      try {
        out = execSync(`bash "${scriptPath}"`, { encoding: "utf8", timeout: 420000, env: process.env });
        status = /\[a4\] PASS/.test(out) ? "pass" : /\[a4\] SKIP/.test(out) ? "skip" : "fail";
      } catch (err: any) {
        out = (err.stdout?.toString?.() ?? "") + (err.stderr?.toString?.() ?? err.message ?? "");
        status = /\[a4\] SKIP/.test(out) ? "skip" : "fail";
      }
    }

    const m = out.match(/\[a4\] METRICS (\{.*\})/);
    if (m) {
      try {
        Object.assign(metrics, JSON.parse(m[1]));
      } catch {
        /* leave metrics as-is */
      }
    }
    metrics.status = status;

    samples.push({
      name: "waker",
      durationMs: performance.now() - t0,
      timestamp: Date.now(),
      error: status === "fail" ? "waker driver did not report PASS" : undefined,
    });

    const passed = status === "pass";
    const endTime = Date.now();
    return {
      scenario: "a4-waker",
      branch: ctx.branch,
      startTime,
      endTime,
      durationMs: endTime - startTime,
      passed,
      metrics,
      samples,
      summary: passed
        ? `A4 waker — real subscription -> real OpenClaw hook: ${metrics.postOk} wake 200s, 3-rapid coalesced to 1, wake latency ${metrics.wakeLatencyMs}ms`
        : status === "skip"
          ? "A4 waker — skipped (no dist-built ad4m plugin; set AD4M_PLUGIN_DIR)"
          : "A4 waker — FAILED (see driver assertions/logs)",
    };
  },
};
