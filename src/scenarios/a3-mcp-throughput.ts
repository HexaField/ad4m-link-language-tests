/**
 * A3 — MCP action round-trip.
 *
 * Measures the MCP action surface a harness drives: repeated write + read-back
 * tool calls against a containerised multi-user node, asserting each round-trips
 * correctly and recording latency (p50/p95/p99), throughput, and error rate.
 *
 * Supersedes the `a1` stub, which never connected because the runner never
 * enabled MCP. Pod-managed + host-isolated; full teardown.
 */
import { McpClient } from "../mcp-client.js";
import { startExecutorContainer, stopContainer, waitForMcpReady } from "../agent-pod.js";
import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";

const ITERATIONS = 50;
const NAME = "a3-mcp-exec";
const PORT = 14200;
const ADMIN = "windtunnel-admin";

export const a3McpThroughput: Scenario = {
  id: "a3",
  name: "MCP Action Round-Trip",
  description:
    "Throughput + correctness of MCP tool actions against a containerised node: write + read-back per iteration; p50/p95/p99 latency, throughput, error rate. Pod-managed, host-isolated. Supersedes the a1 stub.",
  managesOwnEnvironment: true,

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];
    const metrics: Record<string, any> = {};
    const base = `http://127.0.0.1:${PORT}`;
    let passed = false;

    try {
      stopContainer(NAME);
      startExecutorContainer({ name: NAME, hostMcpPort: PORT, adminCredential: ADMIN, agentPassphrase: "windtunnel-pass" });
      await waitForMcpReady(base, ADMIN, 120000);

      const c = new McpClient(base, ADMIN);
      await c.initialize("a3");
      metrics.toolCount = (await c.listTools()).length;

      const persp = await c.callToolJson("add_perspective", { name: "a3-perspective" });
      const uuid = persp?.uuid;
      if (!uuid) throw new Error(`add_perspective returned no uuid: ${JSON.stringify(persp).slice(0, 120)}`);

      const latencies: number[] = [];
      let correct = 0;
      let errors = 0;
      for (let i = 0; i < ITERATIONS; i++) {
        const source = `a3://item/${i}`;
        const target = `a3://value/${i}`;
        const t0 = performance.now();
        try {
          await c.callToolJson("add_link", { perspective_id: uuid, source, predicate: "a3://has", target });
          const q = await c.callToolJson("query_links", { perspective_id: uuid, source });
          const dt = performance.now() - t0;
          latencies.push(dt);
          const found = JSON.stringify(q).includes(target);
          if (found) correct++;
          else errors++;
          samples.push({ name: `rt-${i}`, durationMs: dt, timestamp: Date.now(), error: found ? undefined : "read-back mismatch" });
        } catch (e: any) {
          errors++;
          samples.push({ name: `rt-${i}`, durationMs: performance.now() - t0, timestamp: Date.now(), error: e.message });
        }
      }

      latencies.sort((a, b) => a - b);
      const pct = (p: number) =>
        latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] : 0;
      const totalSec = latencies.reduce((a, b) => a + b, 0) / 1000;
      metrics.iterations = ITERATIONS;
      metrics.correct = correct;
      metrics.errors = errors;
      metrics.p50Ms = +pct(50).toFixed(2);
      metrics.p95Ms = +pct(95).toFixed(2);
      metrics.p99Ms = +pct(99).toFixed(2);
      metrics.throughputPerSec = totalSec > 0 ? +(latencies.length / totalSec).toFixed(1) : 0;
      passed = errors === 0 && correct === ITERATIONS;
    } catch (e: any) {
      metrics.error = e.message;
      passed = false;
    } finally {
      stopContainer(NAME);
    }

    const endTime = Date.now();
    return {
      scenario: "a3-mcp-throughput",
      branch: ctx.branch,
      startTime,
      endTime,
      durationMs: endTime - startTime,
      passed,
      metrics,
      samples,
      summary: passed
        ? `A3 MCP round-trip: ${metrics.correct}/${metrics.iterations} correct, p50 ${metrics.p50Ms}ms / p95 ${metrics.p95Ms}ms, ${metrics.throughputPerSec}/s`
        : `A3 MCP round-trip FAILED: ${metrics.error ?? metrics.errors + " errors"}`,
    };
  },
};
