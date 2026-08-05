/**
 * S5: Query Scaling Scenario
 * Measures Prolog/link query latency vs data size (100, 500, 1000 links).
 * Tests how query performance degrades as data grows.
 */

import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";

const DATA_SIZES = [100, 500, 1000];
const QUERY_ITERATIONS = 5; // run each query N times for stable measurements

export const s5QueryScaling: Scenario = {
  id: "s5",
  name: "Query Scaling",
  description: "Query latency vs data size (100, 500, 1000 links)",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, branch } = ctx;
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];

    // Setup agent
    await client.generateAgent("wind-tunnel-query-scaling");

    const perspective = await client.createPerspective("wind-tunnel-query-scaling");
    if (perspective.error) {
      return {
        scenario: "s5-query-scaling",
        branch,
        startTime,
        endTime: Date.now(),
        durationMs: Date.now() - startTime,
        passed: false,
        metrics: { error: perspective.error },
        samples,
        summary: `Query scaling FAILED: ${perspective.error}`,
      };
    }

    const uuid = perspective.data?.uuid || perspective.data?.id;
    const scalingResults: Array<{
      dataSize: number;
      queryAllAvgMs: number;
      queryBySourceAvgMs: number;
      queryAllLatencies: number[];
      queryBySourceLatencies: number[];
    }> = [];

    let totalLinksAdded = 0;

    for (const targetSize of DATA_SIZES) {
      // Add links until we reach targetSize
      const linksToAdd = targetSize - totalLinksAdded;
      console.log(`  [s5] Adding ${linksToAdd} links to reach ${targetSize} total...`);

      for (let i = 0; i < linksToAdd; i++) {
        const idx = totalLinksAdded + i;
        // Distribute across multiple sources for query variety
        const sourceNum = Math.floor(idx / 10);
        await client.addLink(
          uuid,
          `ad4m://source-${sourceNum}`,
          "ad4m://has",
          `literal://value-${idx}`
        );
      }
      totalLinksAdded = targetSize;

      // Now query multiple times
      const allLatencies: number[] = [];
      const sourceLatencies: number[] = [];

      for (let q = 0; q < QUERY_ITERATIONS; q++) {
        // Query all
        const allQuery = await client.queryLinks(uuid, { predicate: "ad4m://has" });
        allLatencies.push(allQuery.durationMs);
        samples.push({
          name: `query_all_at_${targetSize}_iter_${q}`,
          durationMs: allQuery.durationMs,
          timestamp: allQuery.timestamp,
          error: allQuery.error,
        });

        // Query by specific source (should return ~10 links)
        const sourceQuery = await client.queryLinks(uuid, { source: "ad4m://source-0" });
        sourceLatencies.push(sourceQuery.durationMs);
        samples.push({
          name: `query_source_at_${targetSize}_iter_${q}`,
          durationMs: sourceQuery.durationMs,
          timestamp: sourceQuery.timestamp,
          error: sourceQuery.error,
        });
      }

      const avgAll = allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length;
      const avgSource = sourceLatencies.reduce((a, b) => a + b, 0) / sourceLatencies.length;

      scalingResults.push({
        dataSize: targetSize,
        queryAllAvgMs: Math.round(avgAll * 100) / 100,
        queryBySourceAvgMs: Math.round(avgSource * 100) / 100,
        queryAllLatencies: allLatencies.map((l) => Math.round(l * 100) / 100),
        queryBySourceLatencies: sourceLatencies.map((l) => Math.round(l * 100) / 100),
      });
    }

    const endTime = Date.now();
    const totalMs = endTime - startTime;

    // Calculate scaling factor (how much slower is 1000 vs 100?)
    const first = scalingResults[0];
    const last = scalingResults[scalingResults.length - 1];
    const scalingFactor = first.queryAllAvgMs > 0
      ? last.queryAllAvgMs / first.queryAllAvgMs
      : 0;

    const metrics = {
      dataSizes: DATA_SIZES,
      scalingResults,
      scalingFactor: Math.round(scalingFactor * 100) / 100,
      totalLinksAdded,
    };

    const summaryLines = scalingResults.map(
      (r) => `  ${r.dataSize} links: queryAll=${r.queryAllAvgMs}ms, queryBySource=${r.queryBySourceAvgMs}ms`
    );

    return {
      scenario: "s5-query-scaling",
      branch,
      startTime,
      endTime,
      durationMs: totalMs,
      passed: true,
      metrics,
      samples,
      summary: `Query scaling (${scalingFactor.toFixed(2)}x at ${last.dataSize} vs ${first.dataSize} links):\n${summaryLines.join("\n")}`,
    };
  },
};
