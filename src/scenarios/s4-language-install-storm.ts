/**
 * S4: Language Installation Storm
 * Measures perspective + link operations under increasing perspective load
 * as a proxy for language installation impact. Full language install testing
 * requires template languages and is noted for future work.
 */

import { execSync } from "child_process";
import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import { sleep } from "../executor.js";

const CONCURRENT_BATCHES = [5, 10, 20];
const LINKS_PER_BATCH_ITEM = 10;

function getRssKb(pid: number): number | null {
  try {
    const output = execSync(`ps -o rss= -p ${pid}`, { encoding: "utf8", timeout: 5000 });
    return parseInt(output.trim(), 10);
  } catch {
    return null;
  }
}

export const s4LanguageInstallStorm: Scenario = {
  id: "s4",
  name: "Language Installation Storm",
  description: "Concurrent perspective+link operations as proxy for language installation load",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, branch, port } = ctx;
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];

    // Generate agent
    await client.generateAgent("wind-tunnel-lang-storm");

    // Get PID for RSS
    let executorPid: number | null = null;
    try {
      const psOutput = execSync(`lsof -ti :${port}`, { encoding: "utf8", timeout: 5000 });
      executorPid = parseInt(psOutput.trim().split("\n")[0], 10);
    } catch {}

    const initialRss = executorPid ? getRssKb(executorPid) : null;
    const batchResults: {
      concurrency: number;
      avgCreateMs: number;
      avgLinkMs: number;
      totalMs: number;
      errors: number;
      rssKb: number | null;
    }[] = [];

    for (const concurrency of CONCURRENT_BATCHES) {
      const batchStart = performance.now();
      let errors = 0;
      const createTimes: number[] = [];
      const linkTimes: number[] = [];

      // Create perspectives concurrently
      const createPromises = Array.from({ length: concurrency }, (_, i) =>
        client.createPerspective(`lang-storm-${concurrency}-${i}`)
      );
      const createResults = await Promise.all(createPromises);

      for (const result of createResults) {
        createTimes.push(result.durationMs);
        if (result.error) errors++;
        samples.push({
          name: `concurrent_create_${concurrency}`,
          durationMs: result.durationMs,
          timestamp: result.timestamp,
          error: result.error,
        });
      }

      // Add links to each perspective concurrently
      const linkPromises: Promise<any>[] = [];
      for (const result of createResults) {
        if (!result.error) {
          const uuid = result.data?.uuid || result.data?.id;
          for (let j = 0; j < LINKS_PER_BATCH_ITEM; j++) {
            linkPromises.push(
              client.addLink(uuid, `ad4m://storm-${concurrency}`, "ad4m://has", `literal://item-${j}`)
            );
          }
        }
      }

      const linkResults = await Promise.all(linkPromises);
      for (const result of linkResults) {
        linkTimes.push(result.durationMs);
        if (result.error) errors++;
      }

      const batchDuration = performance.now() - batchStart;
      const currentRss = executorPid ? getRssKb(executorPid) : null;

      const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

      batchResults.push({
        concurrency,
        avgCreateMs: Math.round(avg(createTimes) * 100) / 100,
        avgLinkMs: Math.round(avg(linkTimes) * 100) / 100,
        totalMs: Math.round(batchDuration),
        errors,
        rssKb: currentRss,
      });

      await sleep(1000); // Brief cooldown between batches
    }

    const endTime = Date.now();
    const totalMs = endTime - startTime;
    const finalRss = executorPid ? getRssKb(executorPid) : null;

    const metrics = {
      batches: batchResults,
      initialRssKb: initialRss,
      finalRssKb: finalRss,
      rssGrowthKb: initialRss && finalRss ? finalRss - initialRss : null,
      note: "Full language installation testing requires languageApplyTemplateAndPublish API and template languages. This scenario uses concurrent perspective+link operations as a load proxy.",
    };

    const lastBatch = batchResults[batchResults.length - 1];
    return {
      scenario: "s4-language-install-storm",
      branch,
      startTime,
      endTime,
      durationMs: totalMs,
      passed: true,
      metrics,
      samples,
      summary: `Concurrent batches [${CONCURRENT_BATCHES.join(",")}]: Last batch (${lastBatch.concurrency} concurrent) avg create: ${lastBatch.avgCreateMs.toFixed(1)}ms, avg link: ${lastBatch.avgLinkMs.toFixed(1)}ms, ${lastBatch.errors} errors. RSS growth: ${metrics.rssGrowthKb ? `${(metrics.rssGrowthKb / 1024).toFixed(1)}MB` : "N/A"}`,
    };
  },
};
