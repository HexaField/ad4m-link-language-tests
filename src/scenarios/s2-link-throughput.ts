/**
 * S2: Link Throughput Scenario
 * Measures sustained link add/query rate and latency degradation over time.
 * Adds links in batches, measuring per-batch latency to detect degradation.
 */

import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";

const TOTAL_LINKS = 500;
const BATCH_SIZE = 50;

export const s2LinkThroughput: Scenario = {
  id: "s2",
  name: "Link Throughput",
  description: "Sustained link add/query rate, latency degradation over time",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, branch } = ctx;
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];

    // Setup: generate agent + create perspective
    const agent = await client.generateAgent("wind-tunnel-throughput");
    if (agent.error) {
      // Agent might already exist, try perspective directly
    }

    const perspective = await client.createPerspective("wind-tunnel-throughput");
    if (perspective.error) {
      return {
        scenario: "s2-link-throughput",
        branch,
        startTime,
        endTime: Date.now(),
        durationMs: Date.now() - startTime,
        passed: false,
        metrics: { error: perspective.error },
        samples,
        summary: `Link throughput FAILED: ${perspective.error}`,
      };
    }

    const uuid = perspective.data?.uuid || perspective.data?.id;
    const batchLatencies: number[] = [];
    const batchErrors: number[] = [];
    let totalAdded = 0;

    // Add links in batches
    const numBatches = Math.ceil(TOTAL_LINKS / BATCH_SIZE);
    for (let batch = 0; batch < numBatches; batch++) {
      const batchStart = performance.now();
      let batchErrorCount = 0;

      for (let i = 0; i < BATCH_SIZE && totalAdded < TOTAL_LINKS; i++) {
        const linkIdx = totalAdded;
        const result = await client.addLink(
          uuid,
          `ad4m://throughput-${batch}`,
          "ad4m://has",
          `literal://link-${linkIdx}`
        );
        if (result.error) {
          batchErrorCount++;
        }
        samples.push({
          name: `link_add_${linkIdx}`,
          durationMs: result.durationMs,
          timestamp: result.timestamp,
          error: result.error,
        });
        totalAdded++;
      }

      const batchDuration = performance.now() - batchStart;
      batchLatencies.push(batchDuration);
      batchErrors.push(batchErrorCount);
    }

    // Query at different points to measure query scaling
    const queryResults: { count: number; durationMs: number }[] = [];

    // Query all links
    client.resetMetrics();
    const allQuery = await client.queryLinks(uuid, { predicate: "ad4m://has" });
    queryResults.push({ count: TOTAL_LINKS, durationMs: allQuery.durationMs });
    samples.push({
      name: "query_all_links",
      durationMs: allQuery.durationMs,
      timestamp: allQuery.timestamp,
      error: allQuery.error,
    });

    // Query specific source (should be ~BATCH_SIZE links)
    const sourceQuery = await client.queryLinks(uuid, { source: "ad4m://throughput-0" });
    queryResults.push({ count: BATCH_SIZE, durationMs: sourceQuery.durationMs });
    samples.push({
      name: "query_by_source",
      durationMs: sourceQuery.durationMs,
      timestamp: sourceQuery.timestamp,
      error: sourceQuery.error,
    });

    const endTime = Date.now();
    const totalMs = endTime - startTime;

    // Calculate throughput
    const addStats = client.getStats();
    const throughputLinksPerSec = (totalAdded / (totalMs / 1000));

    // Detect degradation: compare first batch vs last batch
    const firstBatchMs = batchLatencies[0] || 0;
    const lastBatchMs = batchLatencies[batchLatencies.length - 1] || 0;
    const degradationRatio = firstBatchMs > 0 ? lastBatchMs / firstBatchMs : 1;

    const metrics = {
      totalLinks: totalAdded,
      totalDurationMs: totalMs,
      throughputLinksPerSec: Math.round(throughputLinksPerSec * 10) / 10,
      batchLatenciesMs: batchLatencies.map((l) => Math.round(l)),
      batchErrors,
      degradationRatio: Math.round(degradationRatio * 100) / 100,
      queryAllMs: allQuery.durationMs,
      queryBySourceMs: sourceQuery.durationMs,
      addAvgMs: addStats.avgMs,
      addP50Ms: addStats.p50Ms,
      addP95Ms: addStats.p95Ms,
      addP99Ms: addStats.p99Ms,
    };

    return {
      scenario: "s2-link-throughput",
      branch,
      startTime,
      endTime,
      durationMs: totalMs,
      passed: true,
      metrics,
      samples,
      summary: `Added ${totalAdded} links at ${throughputLinksPerSec.toFixed(1)} links/s. Avg add: ${addStats.avgMs.toFixed(1)}ms, P95: ${addStats.p95Ms.toFixed(1)}ms. Degradation ratio: ${degradationRatio.toFixed(2)}x`,
    };
  },
};
