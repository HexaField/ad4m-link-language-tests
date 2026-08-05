/**
 * S2b: Million Link Scaling
 * Scales link benchmarks from 500 to 1M links with checkpoints.
 * Measures latency degradation, query performance, and RSS at each tier.
 * Safety valve: stops if addAvgMs > 500ms or RSS > 8GB.
 */

import { execSync } from "child_process";
import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";

const CHECKPOINTS = [1_000, 10_000, 100_000, 500_000, 1_000_000];
const BATCH_SIZE = 500;
const MAX_ADD_AVG_MS = 500;
const MAX_RSS_KB = 8 * 1024 * 1024; // 8GB in KB

const PREDICATES = [
  { uri: "flux://has_message", weight: 0.60 },
  { uri: "flux://has_reaction", weight: 0.20 },
  { uri: "flux://has_reply", weight: 0.10 },
  { uri: "flux://has_thread_message", weight: 0.05 },
  { uri: "flux://has_item", weight: 0.05 },
];

function pickPredicate(): string {
  const r = Math.random();
  let cum = 0;
  for (const p of PREDICATES) {
    cum += p.weight;
    if (r <= cum) return p.uri;
  }
  return PREDICATES[0].uri;
}

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

interface CheckpointResult {
  tier: number;
  addAvgMs: number;
  addP50Ms: number;
  addP95Ms: number;
  addP99Ms: number;
  queryAllMs: number;
  queryBySourceMs: number;
  queryByPredicateMs: number;
  rssKb: number;
  throughputLinksPerSec: number;
  batchCount: number;
  totalLinksAtCheckpoint: number;
}

export const s2bMillionLinks: Scenario = {
  id: "s2b",
  name: "Million Link Scaling",
  description: "Scale link benchmarks to 1M with checkpoints at 1K, 10K, 100K, 500K, 1M",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, branch, port } = ctx;
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];

    // Setup
    await client.generateAgent("wind-tunnel-million-links");
    const perspective = await client.createPerspective("million-links");
    if (perspective.error) {
      return {
        scenario: "s2b-million-links",
        branch,
        startTime,
        endTime: Date.now(),
        durationMs: Date.now() - startTime,
        passed: false,
        metrics: { error: perspective.error },
        samples,
        summary: `S2b FAILED: ${perspective.error}`,
      };
    }

    const uuid = perspective.data?.uuid || perspective.data?.id;

    // Find executor PID for RSS measurement
    let executorPid = 0;
    try {
      const psOutput = execSync(`lsof -ti :${port} 2>/dev/null || true`).toString().trim();
      if (psOutput) executorPid = parseInt(psOutput.split("\n")[0], 10);
    } catch {}

    const checkpointResults: CheckpointResult[] = [];
    let totalAdded = 0;
    let ceilingHit = false;
    let ceilingReason = "";
    let prevCheckpoint = 0;

    // Generate source UUIDs upfront (reuse across batches)
    const sourcePool: string[] = [];
    for (let i = 0; i < 1000; i++) {
      sourcePool.push(`ad4m://channel-${i.toString(36)}`);
    }

    for (const tier of CHECKPOINTS) {
      if (ceilingHit) break;

      const tierStart = performance.now();
      const linksToAdd = tier - prevCheckpoint;
      const batchCount = Math.ceil(linksToAdd / BATCH_SIZE);
      const tierLatencies: number[] = [];

      console.log(`[s2b] Adding links ${prevCheckpoint} → ${tier} (${batchCount} batches of ${BATCH_SIZE})...`);

      for (let batch = 0; batch < batchCount; batch++) {
        const batchStart = performance.now();
        const batchLatencies: number[] = [];

        for (let i = 0; i < BATCH_SIZE && totalAdded < tier; i++) {
          const source = sourcePool[totalAdded % sourcePool.length];
          const predicate = pickPredicate();
          const target = `literal://msg-${totalAdded}`;

          const result = await client.addLink(uuid, source, predicate, target);
          batchLatencies.push(result.durationMs);
          if (result.error) {
            samples.push({
              name: `link_add_error_${totalAdded}`,
              durationMs: result.durationMs,
              timestamp: result.timestamp,
              error: result.error,
            });
          }
          totalAdded++;
        }

        tierLatencies.push(...batchLatencies);
        const batchDuration = performance.now() - batchStart;

        // Log progress every 50 batches
        if (batch > 0 && batch % 50 === 0) {
          const avgLast = batchLatencies.reduce((a, b) => a + b, 0) / batchLatencies.length;
          console.log(`[s2b]   batch ${batch}/${batchCount}, last batch avg: ${avgLast.toFixed(1)}ms, total: ${totalAdded}`);
        }

        // Safety check every 10 batches
        if (batch > 0 && batch % 10 === 0) {
          const recentAvg = batchLatencies.reduce((a, b) => a + b, 0) / batchLatencies.length;
          if (recentAvg > MAX_ADD_AVG_MS) {
            ceilingHit = true;
            ceilingReason = `addAvgMs exceeded ${MAX_ADD_AVG_MS}ms (was ${recentAvg.toFixed(1)}ms)`;
            console.log(`[s2b] CEILING HIT: ${ceilingReason}`);
            break;
          }
          if (executorPid) {
            const rss = getRssKb(executorPid);
            if (rss > MAX_RSS_KB) {
              ceilingHit = true;
              ceilingReason = `RSS exceeded 8GB (was ${(rss / 1024 / 1024).toFixed(1)}GB)`;
              console.log(`[s2b] CEILING HIT: ${ceilingReason}`);
              break;
            }
          }
        }
      }

      // Checkpoint measurements
      const tierDuration = performance.now() - tierStart;
      const sortedTierLatencies = [...tierLatencies].sort((a, b) => a - b);
      const addAvgMs = sortedTierLatencies.reduce((a, b) => a + b, 0) / (sortedTierLatencies.length || 1);

      // Query performance at this checkpoint
      console.log(`[s2b] Checkpoint at ${totalAdded} links — measuring queries...`);

      const queryAllResult = await client.queryLinks(uuid, {});
      const queryBySourceResult = await client.queryLinks(uuid, { source: sourcePool[0] });
      const queryByPredicateResult = await client.queryLinks(uuid, { predicate: "flux://has_message" });

      const rssKb = executorPid ? getRssKb(executorPid) : 0;
      const throughput = tierLatencies.length / (tierDuration / 1000);

      const checkpoint: CheckpointResult = {
        tier: totalAdded,
        addAvgMs: Math.round(addAvgMs * 100) / 100,
        addP50Ms: Math.round(percentile(sortedTierLatencies, 0.50) * 100) / 100,
        addP95Ms: Math.round(percentile(sortedTierLatencies, 0.95) * 100) / 100,
        addP99Ms: Math.round(percentile(sortedTierLatencies, 0.99) * 100) / 100,
        queryAllMs: Math.round(queryAllResult.durationMs * 100) / 100,
        queryBySourceMs: Math.round(queryBySourceResult.durationMs * 100) / 100,
        queryByPredicateMs: Math.round(queryByPredicateResult.durationMs * 100) / 100,
        rssKb,
        throughputLinksPerSec: Math.round(throughput * 10) / 10,
        batchCount: Math.ceil(tierLatencies.length / BATCH_SIZE),
        totalLinksAtCheckpoint: totalAdded,
      };

      checkpointResults.push(checkpoint);
      prevCheckpoint = tier;

      samples.push({
        name: `checkpoint_${totalAdded}`,
        durationMs: tierDuration,
        timestamp: Date.now(),
      });

      console.log(`[s2b] Tier ${totalAdded}: avg=${addAvgMs.toFixed(1)}ms, queryAll=${queryAllResult.durationMs.toFixed(0)}ms, RSS=${(rssKb / 1024).toFixed(0)}MB, throughput=${throughput.toFixed(0)} links/s`);

      // Check safety after queries too
      if (addAvgMs > MAX_ADD_AVG_MS) {
        ceilingHit = true;
        ceilingReason = `addAvgMs exceeded ${MAX_ADD_AVG_MS}ms at tier ${totalAdded}`;
        break;
      }
    }

    const endTime = Date.now();
    const totalMs = endTime - startTime;

    const metrics: Record<string, any> = {
      totalLinksAdded: totalAdded,
      checkpoints: checkpointResults,
      ceilingHit,
      ceilingReason: ceilingReason || null,
      totalDurationMs: totalMs,
      predicateDistribution: PREDICATES.map((p) => ({ uri: p.uri, weight: p.weight })),
    };

    const lastCheckpoint = checkpointResults[checkpointResults.length - 1];
    const summaryParts = [
      `Added ${totalAdded} links total.`,
      lastCheckpoint ? `Final tier: avg=${lastCheckpoint.addAvgMs.toFixed(1)}ms, P95=${lastCheckpoint.addP95Ms.toFixed(1)}ms, queryAll=${lastCheckpoint.queryAllMs.toFixed(0)}ms, RSS=${(lastCheckpoint.rssKb / 1024).toFixed(0)}MB` : "",
      ceilingHit ? `CEILING: ${ceilingReason}` : "Completed all tiers.",
    ];

    return {
      scenario: "s2b-million-links",
      branch,
      startTime,
      endTime,
      durationMs: totalMs,
      passed: true,
      metrics,
      samples,
      summary: summaryParts.filter(Boolean).join(" "),
    };
  },
};
