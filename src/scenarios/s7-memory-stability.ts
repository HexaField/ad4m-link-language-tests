/**
 * S7: Memory Stability (Short Run)
 * Run a steady-state workload for 5 minutes:
 * - Add 1 link/sec
 * - Query every 10s
 * - Create a perspective every 60s
 * - Sample RSS every 30s
 * Report: RSS growth rate (MB/min), final RSS, growth trend
 */

import { execSync } from "child_process";
import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import { sleep } from "../executor.js";

const DURATION_MS = 5 * 60 * 1000; // 5 minutes
const LINK_INTERVAL_MS = 1000;
const QUERY_INTERVAL_MS = 10000;
const PERSPECTIVE_INTERVAL_MS = 60000;
const RSS_SAMPLE_INTERVAL_MS = 30000;

function getRssKb(pid: number): number | null {
  try {
    const output = execSync(`ps -o rss= -p ${pid}`, { encoding: "utf8", timeout: 5000 });
    return parseInt(output.trim(), 10);
  } catch {
    return null;
  }
}

export const s7MemoryStability: Scenario = {
  id: "s7",
  name: "Memory Stability",
  description: "5-minute steady-state workload measuring RSS growth rate",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, branch, port } = ctx;
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];

    // Generate agent
    await client.generateAgent("wind-tunnel-memory-stability");

    // Get executor PID
    let executorPid: number | null = null;
    try {
      const psOutput = execSync(`lsof -ti :${port}`, { encoding: "utf8", timeout: 5000 });
      executorPid = parseInt(psOutput.trim().split("\n")[0], 10);
    } catch {}

    // Create initial perspective
    const perspective = await client.createPerspective("memory-stability-0");
    if (perspective.error) {
      return {
        scenario: "s7-memory-stability",
        branch,
        startTime,
        endTime: Date.now(),
        durationMs: Date.now() - startTime,
        passed: false,
        metrics: { error: perspective.error },
        samples,
        summary: `S7 FAILED: ${perspective.error}`,
      };
    }

    let currentUuid = perspective.data?.uuid || perspective.data?.id;
    let perspectiveCount = 1;
    let linkCount = 0;
    let queryCount = 0;

    const rssSamples: { elapsedMs: number; rssKb: number }[] = [];
    const linkLatencies: number[] = [];
    const queryLatencies: number[] = [];

    // Initial RSS
    if (executorPid) {
      const rss = getRssKb(executorPid);
      if (rss) rssSamples.push({ elapsedMs: 0, rssKb: rss });
    }

    // Schedule operations using a simple loop with timing checks
    let lastLinkTime = 0;
    let lastQueryTime = 0;
    let lastPerspectiveTime = 0;
    let lastRssTime = 0;

    const runStart = performance.now();

    while (performance.now() - runStart < DURATION_MS) {
      const elapsed = performance.now() - runStart;

      // Add link every second
      if (elapsed - lastLinkTime >= LINK_INTERVAL_MS) {
        lastLinkTime = elapsed;
        const result = await client.addLink(
          currentUuid,
          `ad4m://stability`,
          "ad4m://has",
          `literal://link-${linkCount}`
        );
        linkLatencies.push(result.durationMs);
        linkCount++;

        if (linkCount % 30 === 0) {
          samples.push({
            name: `link_add_${linkCount}`,
            durationMs: result.durationMs,
            timestamp: result.timestamp,
            error: result.error,
          });
        }
      }

      // Query every 10s
      if (elapsed - lastQueryTime >= QUERY_INTERVAL_MS) {
        lastQueryTime = elapsed;
        const result = await client.queryLinks(currentUuid, { predicate: "ad4m://has" });
        queryLatencies.push(result.durationMs);
        queryCount++;
        samples.push({
          name: `query_${queryCount}`,
          durationMs: result.durationMs,
          timestamp: result.timestamp,
          error: result.error,
        });
      }

      // Create perspective every 60s
      if (elapsed - lastPerspectiveTime >= PERSPECTIVE_INTERVAL_MS) {
        lastPerspectiveTime = elapsed;
        const result = await client.createPerspective(`memory-stability-${perspectiveCount}`);
        if (!result.error) {
          currentUuid = result.data?.uuid || result.data?.id;
          perspectiveCount++;
        }
        samples.push({
          name: `perspective_create_${perspectiveCount}`,
          durationMs: result.durationMs,
          timestamp: result.timestamp,
          error: result.error,
        });
      }

      // Sample RSS every 30s
      if (elapsed - lastRssTime >= RSS_SAMPLE_INTERVAL_MS) {
        lastRssTime = elapsed;
        if (executorPid) {
          const rss = getRssKb(executorPid);
          if (rss) rssSamples.push({ elapsedMs: Math.round(elapsed), rssKb: rss });
        }
      }

      // Small sleep to avoid busy-waiting
      await sleep(100);
    }

    // Final RSS sample
    if (executorPid) {
      const rss = getRssKb(executorPid);
      if (rss) rssSamples.push({ elapsedMs: Math.round(performance.now() - runStart), rssKb: rss });
    }

    const endTime = Date.now();
    const totalMs = endTime - startTime;

    // Calculate RSS growth rate
    const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const p95 = (arr: number[]) => {
      if (arr.length === 0) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length * 0.95)];
    };

    let rssGrowthRateKbPerMin: number | null = null;
    let rssGrowthTrend: string = "unknown";

    if (rssSamples.length >= 2) {
      const first = rssSamples[0];
      const last = rssSamples[rssSamples.length - 1];
      const elapsedMin = (last.elapsedMs - first.elapsedMs) / 60000;
      if (elapsedMin > 0) {
        rssGrowthRateKbPerMin = (last.rssKb - first.rssKb) / elapsedMin;
        if (rssGrowthRateKbPerMin < 100) rssGrowthTrend = "stable";
        else if (rssGrowthRateKbPerMin < 1024) rssGrowthTrend = "slow_growth";
        else rssGrowthTrend = "growing";
      }
    }

    const metrics = {
      durationMs: DURATION_MS,
      linksAdded: linkCount,
      queriesPerformed: queryCount,
      perspectivesCreated: perspectiveCount,
      linkLatency: {
        avgMs: Math.round(avg(linkLatencies) * 100) / 100,
        p95Ms: Math.round(p95(linkLatencies) * 100) / 100,
      },
      queryLatency: {
        avgMs: Math.round(avg(queryLatencies) * 100) / 100,
        p95Ms: Math.round(p95(queryLatencies) * 100) / 100,
      },
      rss: {
        samples: rssSamples,
        initialKb: rssSamples.length > 0 ? rssSamples[0].rssKb : null,
        finalKb: rssSamples.length > 0 ? rssSamples[rssSamples.length - 1].rssKb : null,
        growthRateKbPerMin: rssGrowthRateKbPerMin ? Math.round(rssGrowthRateKbPerMin) : null,
        growthRateMbPerMin: rssGrowthRateKbPerMin ? Math.round(rssGrowthRateKbPerMin / 1024 * 100) / 100 : null,
        trend: rssGrowthTrend,
      },
    };

    return {
      scenario: "s7-memory-stability",
      branch,
      startTime,
      endTime,
      durationMs: totalMs,
      passed: true,
      metrics,
      samples,
      summary: `5-min run: ${linkCount} links, ${queryCount} queries, ${perspectiveCount} perspectives. Link avg: ${avg(linkLatencies).toFixed(1)}ms. RSS: ${metrics.rss.initialKb ? `${(metrics.rss.initialKb / 1024).toFixed(0)}MB` : "?"} → ${metrics.rss.finalKb ? `${(metrics.rss.finalKb / 1024).toFixed(0)}MB` : "?"} (${metrics.rss.growthRateMbPerMin ?? "?"}MB/min, ${rssGrowthTrend})`,
    };
  },
};
