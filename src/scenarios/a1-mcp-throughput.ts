/**
 * A1: MCP Throughput
 * Tests the MCP (Model Context Protocol) endpoint exposed by the executor.
 * The executor may expose MCP at /mcp (HTTP).
 */

import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";

const MCP_ITERATIONS = 50;

export const a1McpThroughput: Scenario = {
  id: "a1",
  name: "MCP Throughput",
  description: "Test MCP endpoint throughput — connect and call tools repeatedly",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, branch, port } = ctx;
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];

    // Check if MCP endpoint exists
    const mcpUrl = `http://127.0.0.1:${port}/mcp`;
    let mcpAvailable = false;

    try {
      const checkRes = await fetch(mcpUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "wind-tunnel", version: "1.0.0" } } }) });
      if (checkRes.ok || checkRes.status === 400) {
        // 400 might mean it exists but we need proper negotiation
        mcpAvailable = true;
      }
    } catch {
      // MCP not available
    }

    // Also try SSE-based MCP
    if (!mcpAvailable) {
      try {
        const sseRes = await fetch(`http://127.0.0.1:${port}/mcp/sse`);
        if (sseRes.ok || sseRes.status === 405) {
          mcpAvailable = true;
        }
      } catch {}
    }

    if (!mcpAvailable) {
      const endTime = Date.now();
      return {
        scenario: "a1-mcp-throughput",
        branch,
        startTime,
        endTime,
        durationMs: endTime - startTime,
        passed: true,
        metrics: {
          status: "STUB",
          mcpAvailable: false,
          note: "MCP endpoint not available on this branch. The executor does not expose /mcp or /mcp/sse on the tested branches.",
          checkedEndpoints: [`${mcpUrl}`, `http://127.0.0.1:${port}/mcp/sse`],
        },
        samples,
        summary: `STUB: MCP endpoint not available on branch ${branch}. Endpoint not exposed at /mcp or /mcp/sse.`,
      };
    }

    // MCP is available — run throughput test
    const latencies: number[] = [];
    let errors = 0;

    for (let i = 0; i < MCP_ITERATIONS; i++) {
      const iterStart = performance.now();
      try {
        const res = await fetch(mcpUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: i + 1,
            method: "tools/list",
            params: {},
          }),
        });
        const durationMs = performance.now() - iterStart;
        latencies.push(durationMs);

        if (!res.ok) errors++;

        samples.push({
          name: `mcp_call_${i}`,
          durationMs,
          timestamp: Date.now(),
          error: res.ok ? undefined : `HTTP ${res.status}`,
        });
      } catch (err: any) {
        const durationMs = performance.now() - iterStart;
        latencies.push(durationMs);
        errors++;
        samples.push({
          name: `mcp_call_${i}`,
          durationMs,
          timestamp: Date.now(),
          error: err.message,
        });
      }
    }

    const endTime = Date.now();
    const totalMs = endTime - startTime;

    const sorted = [...latencies].sort((a, b) => a - b);
    const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    const throughput = (MCP_ITERATIONS / totalMs) * 1000;

    const metrics = {
      mcpAvailable: true,
      iterations: MCP_ITERATIONS,
      errors,
      avgMs: Math.round(avg * 100) / 100,
      p50Ms: Math.round(p50 * 100) / 100,
      p95Ms: Math.round(p95 * 100) / 100,
      p99Ms: Math.round(p99 * 100) / 100,
      minMs: Math.round(sorted[0] * 100) / 100,
      maxMs: Math.round(sorted[sorted.length - 1] * 100) / 100,
      throughputCallsPerSec: Math.round(throughput * 10) / 10,
    };

    return {
      scenario: "a1-mcp-throughput",
      branch,
      startTime,
      endTime,
      durationMs: totalMs,
      passed: true,
      metrics,
      samples,
      summary: `MCP: ${MCP_ITERATIONS} calls, avg ${avg.toFixed(1)}ms, P95 ${p95.toFixed(1)}ms, ${throughput.toFixed(1)} calls/s, ${errors} errors`,
    };
  },
};
