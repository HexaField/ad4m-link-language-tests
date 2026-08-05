/**
 * S14: Multi-Perspective Load
 * Realistic multi-perspective load pattern.
 * - Create 20 perspectives
 * - Each gets 5K links
 * - Measure: cross-perspective query isolation, total RSS, per-perspective latency degradation
 * - Key metric: 20th perspective performance vs 1st perspective
 */

import { execSync } from "child_process";
import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import { sleep } from "../executor.js";

const PERSPECTIVE_COUNT = 20;
const LINKS_PER_PERSPECTIVE = 5_000;
const BATCH_SIZE = 500;

function getRssKb(pid: number): number {
  try {
    const output = execSync(`ps -o rss= -p ${pid}`).toString().trim();
    return parseInt(output, 10) || 0;
  } catch {
    return 0;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

interface PerspectiveMetrics {
  index: number;
  uuid: string;
  addAvgMs: number;
  addP50Ms: number;
  addP95Ms: number;
  queryAllMs: number;
  queryBySourceMs: number;
  linkCount: number;
  rssKbAfter: number;
}

export const s14MultiPerspectiveLoad: Scenario = {
  id: "s14",
  name: "Multi-Perspective Load",
  description: "20 perspectives × 5K links each, measure isolation and degradation",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, branch, port } = ctx;
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];

    // Setup
    await client.generateAgent("wind-tunnel-multi-perspective");

    // Find executor PID
    let executorPid = 0;
    try {
      const psOutput = execSync(`lsof -ti :${port} 2>/dev/null || true`).toString().trim();
      if (psOutput) executorPid = parseInt(psOutput.split("\n")[0], 10);
    } catch {}

    const baselineRss = executorPid ? getRssKb(executorPid) : 0;
    const perspectiveMetrics: PerspectiveMetrics[] = [];
    const perspectiveUuids: string[] = [];

    // Phase 1: Create all perspectives
    console.log(`[s14] Creating ${PERSPECTIVE_COUNT} perspectives...`);
    for (let i = 0; i < PERSPECTIVE_COUNT; i++) {
      const result = await client.createPerspective(`multi-load-${i}`);
      if (result.error) {
        console.log(`[s14] Failed to create perspective ${i}: ${result.error}`);
        continue;
      }
      const uuid = result.data?.uuid || result.data?.id;
      perspectiveUuids.push(uuid);
    }

    if (perspectiveUuids.length === 0) {
      return {
        scenario: "s14-multi-perspective-load",
        branch,
        startTime,
        endTime: Date.now(),
        durationMs: Date.now() - startTime,
        passed: false,
        metrics: { error: "No perspectives created" },
        samples,
        summary: `S14 FAILED: no perspectives`,
      };
    }

    console.log(`[s14] Created ${perspectiveUuids.length} perspectives. Loading ${LINKS_PER_PERSPECTIVE} links each...`);

    // Phase 2: Load links into each perspective and measure per-perspective performance
    for (let pIdx = 0; pIdx < perspectiveUuids.length; pIdx++) {
      const uuid = perspectiveUuids[pIdx];
      const pStart = performance.now();
      const addLatencies: number[] = [];
      let addErrors = 0;

      console.log(`[s14] Perspective ${pIdx + 1}/${perspectiveUuids.length}: adding ${LINKS_PER_PERSPECTIVE} links...`);

      // Add links
      for (let i = 0; i < LINKS_PER_PERSPECTIVE; i++) {
        const source = `ad4m://channel-${i % 50}`;
        const result = await client.addLink(uuid, source, "ad4m://has_message", `literal://msg-${pIdx}-${i}`);
        addLatencies.push(result.durationMs);
        if (result.error) addErrors++;

        if ((i + 1) % 1000 === 0 && pIdx % 5 === 0) {
          console.log(`[s14]   P${pIdx}: ${i + 1}/${LINKS_PER_PERSPECTIVE}...`);
        }
      }

      // Query performance on this perspective
      const queryAllResult = await client.queryLinks(uuid, {});
      const queryBySourceResult = await client.queryLinks(uuid, { source: "ad4m://channel-0" });

      const rssNow = executorPid ? getRssKb(executorPid) : 0;
      const sortedAdd = [...addLatencies].sort((a, b) => a - b);

      const metrics: PerspectiveMetrics = {
        index: pIdx,
        uuid,
        addAvgMs: Math.round((sortedAdd.reduce((a, b) => a + b, 0) / sortedAdd.length) * 100) / 100,
        addP50Ms: Math.round(percentile(sortedAdd, 0.5) * 100) / 100,
        addP95Ms: Math.round(percentile(sortedAdd, 0.95) * 100) / 100,
        queryAllMs: Math.round(queryAllResult.durationMs * 100) / 100,
        queryBySourceMs: Math.round(queryBySourceResult.durationMs * 100) / 100,
        linkCount: Array.isArray(queryAllResult.data) ? queryAllResult.data.length : 0,
        rssKbAfter: rssNow,
      };

      perspectiveMetrics.push(metrics);

      const pDuration = performance.now() - pStart;
      samples.push({
        name: `perspective_${pIdx}`,
        durationMs: pDuration,
        timestamp: Date.now(),
      });

      if (pIdx % 5 === 0 || pIdx === perspectiveUuids.length - 1) {
        console.log(`[s14] P${pIdx}: addAvg=${metrics.addAvgMs.toFixed(1)}ms, queryAll=${metrics.queryAllMs.toFixed(0)}ms, RSS=${(rssNow / 1024).toFixed(0)}MB`);
      }
    }

    // Phase 3: Cross-perspective query isolation test
    // Query first perspective after all loading — should still be fast
    console.log(`[s14] Cross-perspective isolation check...`);
    const isolationResults: { perspectiveIdx: number; queryMs: number; linkCount: number }[] = [];

    for (let i = 0; i < Math.min(perspectiveUuids.length, 5); i++) {
      // Check perspectives 0, 5, 10, 15, 19
      const checkIdx = i === 4 ? perspectiveUuids.length - 1 : i * 5;
      if (checkIdx >= perspectiveUuids.length) continue;

      const result = await client.queryLinks(perspectiveUuids[checkIdx], { source: "ad4m://channel-0" });
      isolationResults.push({
        perspectiveIdx: checkIdx,
        queryMs: Math.round(result.durationMs * 100) / 100,
        linkCount: Array.isArray(result.data) ? result.data.length : 0,
      });
    }

    const finalRss = executorPid ? getRssKb(executorPid) : 0;

    const endTime = Date.now();
    const totalMs = endTime - startTime;

    // Key comparison: first vs last perspective
    const firstP = perspectiveMetrics[0];
    const lastP = perspectiveMetrics[perspectiveMetrics.length - 1];
    const addDegradation = firstP && lastP && firstP.addAvgMs > 0
      ? Math.round((lastP.addAvgMs / firstP.addAvgMs) * 100) / 100 : 0;
    const queryDegradation = firstP && lastP && firstP.queryAllMs > 0
      ? Math.round((lastP.queryAllMs / firstP.queryAllMs) * 100) / 100 : 0;

    const metricsOut = {
      perspectiveCount: perspectiveUuids.length,
      linksPerPerspective: LINKS_PER_PERSPECTIVE,
      totalLinks: perspectiveUuids.length * LINKS_PER_PERSPECTIVE,
      perspectiveMetrics: perspectiveMetrics.map((pm) => ({
        index: pm.index,
        addAvgMs: pm.addAvgMs,
        addP95Ms: pm.addP95Ms,
        queryAllMs: pm.queryAllMs,
        queryBySourceMs: pm.queryBySourceMs,
        rssKbAfter: pm.rssKbAfter,
      })),
      degradation: {
        firstPerspective: {
          addAvgMs: firstP?.addAvgMs || 0,
          queryAllMs: firstP?.queryAllMs || 0,
        },
        lastPerspective: {
          addAvgMs: lastP?.addAvgMs || 0,
          queryAllMs: lastP?.queryAllMs || 0,
        },
        addLatencyDegradation: addDegradation,
        queryLatencyDegradation: queryDegradation,
      },
      isolation: isolationResults,
      memory: {
        baselineRssKb: baselineRss,
        finalRssKb: finalRss,
        totalRssDeltaMb: Math.round((finalRss - baselineRss) / 1024),
        rssPerPerspectiveMb: Math.round(((finalRss - baselineRss) / perspectiveUuids.length) / 1024 * 10) / 10,
      },
    };

    const summary = [
      `${perspectiveUuids.length} perspectives × ${LINKS_PER_PERSPECTIVE} links = ${perspectiveUuids.length * LINKS_PER_PERSPECTIVE} total.`,
      `Degradation P1→P${perspectiveUuids.length}: add ${addDegradation}x, query ${queryDegradation}x.`,
      firstP && lastP ? `P1 addAvg=${firstP.addAvgMs.toFixed(1)}ms → P${perspectiveUuids.length} addAvg=${lastP.addAvgMs.toFixed(1)}ms.` : "",
      `RSS delta: ${metricsOut.memory.totalRssDeltaMb}MB total (${metricsOut.memory.rssPerPerspectiveMb}MB/perspective).`,
    ].join(" ");

    return {
      scenario: "s14-multi-perspective-load",
      branch,
      startTime,
      endTime,
      durationMs: totalMs,
      passed: true,
      metrics: metricsOut,
      samples,
      summary,
    };
  },
};
