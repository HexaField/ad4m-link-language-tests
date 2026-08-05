/**
 * M3: Link Language Comparison
 * Starts Docker infrastructure for Matrix/Nostr/IPFS/AT Protocol/Solid,
 * measures startup time and health check latency for each service,
 * and runs local perspective baseline operations for comparison.
 * Full link language installation requires manual setup (future iteration).
 */

import { execSync, spawnSync } from "child_process";
import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import { sleep } from "../executor.js";

interface ServiceHealth {
  name: string;
  port: number;
  healthUrl: string;
  healthy: boolean;
  latencyMs: number;
  error?: string;
}

const SERVICES = [
  { name: "matrix-conduit", port: 6167, healthUrl: "http://localhost:6167/_matrix/client/versions" },
  { name: "atproto-pds", port: 2583, healthUrl: "http://localhost:2583/xrpc/_health" },
  { name: "solid-server", port: 3000, healthUrl: "http://localhost:3000/" },
  { name: "ipfs-node", port: 5001, healthUrl: "http://localhost:5001/api/v0/id" },
  { name: "nostr-relay", port: 7777, healthUrl: null as any }, // WebSocket, check with TCP
];

async function checkServiceHealth(service: typeof SERVICES[0]): Promise<ServiceHealth> {
  const start = performance.now();
  try {
    if (!service.healthUrl) {
      // TCP check for WebSocket services
      const result = spawnSync("nc", ["-z", "localhost", String(service.port)], { timeout: 5000 });
      const latency = performance.now() - start;
      return {
        name: service.name,
        port: service.port,
        healthUrl: `tcp://localhost:${service.port}`,
        healthy: result.status === 0,
        latencyMs: Math.round(latency * 100) / 100,
        error: result.status !== 0 ? "TCP connection refused" : undefined,
      };
    }

    const res = await fetch(service.healthUrl, { signal: AbortSignal.timeout(5000) });
    const latency = performance.now() - start;
    return {
      name: service.name,
      port: service.port,
      healthUrl: service.healthUrl,
      healthy: res.ok,
      latencyMs: Math.round(latency * 100) / 100,
      error: !res.ok ? `HTTP ${res.status}` : undefined,
    };
  } catch (err: any) {
    return {
      name: service.name,
      port: service.port,
      healthUrl: service.healthUrl || `tcp://localhost:${service.port}`,
      healthy: false,
      latencyMs: Math.round((performance.now() - start) * 100) / 100,
      error: err.message,
    };
  }
}

async function waitForServices(timeoutMs: number = 120000): Promise<{ services: ServiceHealth[]; totalWaitMs: number }> {
  const start = performance.now();
  const deadline = start + timeoutMs;
  let allHealthy = false;
  let services: ServiceHealth[] = [];

  while (performance.now() < deadline) {
    services = await Promise.all(SERVICES.map(checkServiceHealth));
    allHealthy = services.filter(s => s.name !== "nostr-relay").every(s => s.healthy);
    // nostr uses TCP check which may be flaky; count it as optional
    if (allHealthy) break;
    await sleep(3000);
  }

  return { services, totalWaitMs: performance.now() - start };
}

export const m3LinkLanguageComparison: Scenario = {
  id: "m3",
  name: "Link Language Comparison",
  description: "Docker infrastructure readiness + local perspective baseline for link language comparison",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, branch, port } = ctx;
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];
    let dockerStarted = false;

    try {
      // Check if Docker is available
      const dockerCheck = spawnSync("docker", ["info"], { timeout: 10000 });
      if (dockerCheck.status !== 0) {
        return {
          scenario: "m3-link-language-comparison",
          branch,
          startTime,
          endTime: Date.now(),
          durationMs: Date.now() - startTime,
          passed: true,
          metrics: { error: "Docker not available", dockerInstalled: false },
          samples,
          summary: "M3 SKIPPED: Docker not available on this machine.",
        };
      }

      // Start Docker infrastructure
      console.log("[m3] Starting Docker infrastructure...");
      const dockerStartTime = performance.now();

      try {
        execSync(
          "docker compose -f interop/docker-compose.yml up -d 2>&1",
          { cwd: process.cwd(), timeout: 120000, stdio: "pipe" }
        );
        dockerStarted = true;
      } catch (err: any) {
        const dockerDuration = performance.now() - dockerStartTime;
        return {
          scenario: "m3-link-language-comparison",
          branch,
          startTime,
          endTime: Date.now(),
          durationMs: Date.now() - startTime,
          passed: false,
          metrics: {
            error: `Docker compose failed: ${err.message?.substring(0, 200)}`,
            dockerStartAttemptMs: Math.round(dockerDuration),
          },
          samples,
          summary: `M3 FAILED: Docker compose could not start. ${err.message?.substring(0, 100)}`,
        };
      }

      const dockerStartDuration = performance.now() - dockerStartTime;
      console.log(`[m3] Docker compose up in ${(dockerStartDuration / 1000).toFixed(1)}s`);

      samples.push({
        name: "docker_compose_up",
        durationMs: dockerStartDuration,
        timestamp: Date.now(),
      });

      // Wait for services to become healthy
      console.log("[m3] Waiting for services to become healthy...");
      const { services, totalWaitMs } = await waitForServices(120000);

      samples.push({
        name: "services_healthy_wait",
        durationMs: totalWaitMs,
        timestamp: Date.now(),
      });

      const healthyCount = services.filter(s => s.healthy).length;
      console.log(`[m3] ${healthyCount}/${services.length} services healthy after ${(totalWaitMs / 1000).toFixed(1)}s`);

      // Measure service health check latency (multiple samples)
      console.log("[m3] Benchmarking health check latency...");
      const healthLatencies: Record<string, number[]> = {};
      for (let i = 0; i < 10; i++) {
        for (const service of SERVICES) {
          const result = await checkServiceHealth(service);
          if (!healthLatencies[service.name]) healthLatencies[service.name] = [];
          if (result.healthy) healthLatencies[service.name].push(result.latencyMs);
        }
        await sleep(200);
      }

      const healthBenchmarks: Record<string, { avgMs: number; minMs: number; maxMs: number; samples: number }> = {};
      for (const [name, latencies] of Object.entries(healthLatencies)) {
        if (latencies.length > 0) {
          const sorted = [...latencies].sort((a, b) => a - b);
          healthBenchmarks[name] = {
            avgMs: Math.round((sorted.reduce((a, b) => a + b, 0) / sorted.length) * 100) / 100,
            minMs: Math.round(sorted[0] * 100) / 100,
            maxMs: Math.round(sorted[sorted.length - 1] * 100) / 100,
            samples: sorted.length,
          };
        }
      }

      // Local perspective baseline
      console.log("[m3] Running local perspective baseline...");
      await client.generateAgent("wind-tunnel-m3");
      const perspective = await client.createPerspective("m3-local-baseline");
      const baseUuid = perspective.data?.uuid || perspective.data?.id;

      const LINK_COUNTS = [100, 500, 1000];
      const baselineResults: Record<number, { addAvgMs: number; queryAvgMs: number; throughputLinksPerSec: number }> = {};

      for (const count of LINK_COUNTS) {
        const addStart = performance.now();
        const addLatencies: number[] = [];

        for (let i = 0; i < count; i++) {
          const result = await client.addLink(
            baseUuid,
            `ad4m://m3-source-${i % 20}`,
            "ad4m://has",
            `literal://m3-target-${i}`
          );
          addLatencies.push(result.durationMs);
        }

        const addDuration = performance.now() - addStart;

        // Query
        const queryLatencies: number[] = [];
        for (let q = 0; q < 5; q++) {
          const qResult = await client.queryLinks(baseUuid, { predicate: "ad4m://has" });
          queryLatencies.push(qResult.durationMs);
        }

        baselineResults[count] = {
          addAvgMs: Math.round((addLatencies.reduce((a, b) => a + b, 0) / addLatencies.length) * 100) / 100,
          queryAvgMs: Math.round((queryLatencies.reduce((a, b) => a + b, 0) / queryLatencies.length) * 100) / 100,
          throughputLinksPerSec: Math.round((count / (addDuration / 1000)) * 10) / 10,
        };

        samples.push({
          name: `baseline_${count}_links`,
          durationMs: addDuration,
          timestamp: Date.now(),
        });
      }

      const endTime = Date.now();
      const totalMs = endTime - startTime;

      const metrics = {
        dockerStartupMs: Math.round(dockerStartDuration),
        serviceHealthWaitMs: Math.round(totalWaitMs),
        services: services.map(s => ({ name: s.name, port: s.port, healthy: s.healthy, error: s.error })),
        healthBenchmarks,
        localBaseline: baselineResults,
        note: "Full link language comparison requires language installation (future iteration). This measures infrastructure readiness and local baseline.",
      };

      return {
        scenario: "m3-link-language-comparison",
        branch,
        startTime,
        endTime,
        durationMs: totalMs,
        passed: true,
        metrics,
        samples,
        summary: `Docker infra: ${healthyCount}/${services.length} healthy in ${(totalWaitMs / 1000).toFixed(1)}s. Local baseline at 1000 links: add=${baselineResults[1000]?.addAvgMs.toFixed(1)}ms, query=${baselineResults[1000]?.queryAvgMs.toFixed(0)}ms, ${baselineResults[1000]?.throughputLinksPerSec.toFixed(0)} links/s`,
      };

    } finally {
      // Cleanup Docker
      if (dockerStarted) {
        console.log("[m3] Cleaning up Docker infrastructure...");
        try {
          execSync(
            "docker compose -f interop/docker-compose.yml down -v 2>&1",
            { cwd: process.cwd(), timeout: 60000, stdio: "pipe" }
          );
        } catch (err: any) {
          console.log(`[m3] Docker cleanup warning: ${err.message?.substring(0, 100)}`);
        }
      }
    }
  },
};
