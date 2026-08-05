/**
 * S3: Perspective Scaling
 * Create N perspectives sequentially (10, 50, 100), add M links to each,
 * measure creation time and RSS growth.
 */

import { execSync } from "child_process";
import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";

const PERSPECTIVE_COUNTS = [10, 50, 100];
const LINKS_PER_PERSPECTIVE = 5;

function getRssKb(pid: number): number | null {
  try {
    const output = execSync(`ps -o rss= -p ${pid}`, { encoding: "utf8", timeout: 5000 });
    return parseInt(output.trim(), 10);
  } catch {
    return null;
  }
}

export const s3PerspectiveScaling: Scenario = {
  id: "s3",
  name: "Perspective Scaling",
  description: "Create N perspectives sequentially, measure creation time and RSS growth",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, branch, port } = ctx;
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];

    // Generate agent
    const agent = await client.generateAgent("wind-tunnel-perspective-scaling");
    if (agent.error) {
      // Agent might already exist
    }

    // Try to get executor PID for RSS measurement
    let executorPid: number | null = null;
    try {
      const psOutput = execSync(`lsof -ti :${port}`, { encoding: "utf8", timeout: 5000 });
      executorPid = parseInt(psOutput.trim().split("\n")[0], 10);
    } catch {}

    const initialRssKb = executorPid ? getRssKb(executorPid) : null;
    const rssSnapshots: { perspectiveCount: number; rssKb: number }[] = [];
    if (initialRssKb) {
      rssSnapshots.push({ perspectiveCount: 0, rssKb: initialRssKb });
    }

    const phaseResults: { targetCount: number; creationTimes: number[]; linkTimes: number[]; rssKb: number | null }[] = [];
    let totalPerspectives = 0;

    for (const targetCount of PERSPECTIVE_COUNTS) {
      const toCreate = targetCount - totalPerspectives;
      const creationTimes: number[] = [];
      const linkTimes: number[] = [];

      for (let i = 0; i < toCreate; i++) {
        const idx = totalPerspectives + i;
        const result = await client.createPerspective(`scaling-test-${idx}`);
        creationTimes.push(result.durationMs);
        samples.push({
          name: `perspective_create_${idx}`,
          durationMs: result.durationMs,
          timestamp: result.timestamp,
          error: result.error,
        });

        if (!result.error) {
          const uuid = result.data?.uuid || result.data?.id;
          // Add some links to each perspective
          for (let j = 0; j < LINKS_PER_PERSPECTIVE; j++) {
            const linkResult = await client.addLink(
              uuid,
              `ad4m://scaling-${idx}`,
              "ad4m://has",
              `literal://item-${j}`
            );
            linkTimes.push(linkResult.durationMs);
            if (j === 0) {
              samples.push({
                name: `link_add_perspective_${idx}`,
                durationMs: linkResult.durationMs,
                timestamp: linkResult.timestamp,
                error: linkResult.error,
              });
            }
          }
        }
      }

      totalPerspectives = targetCount;
      const currentRss = executorPid ? getRssKb(executorPid) : null;
      if (currentRss) {
        rssSnapshots.push({ perspectiveCount: targetCount, rssKb: currentRss });
      }

      phaseResults.push({
        targetCount,
        creationTimes,
        linkTimes,
        rssKb: currentRss,
      });
    }

    const endTime = Date.now();
    const totalMs = endTime - startTime;

    const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const p95 = (arr: number[]) => {
      if (arr.length === 0) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length * 0.95)];
    };

    const metrics = {
      phases: phaseResults.map((p) => ({
        perspectiveCount: p.targetCount,
        avgCreateMs: Math.round(avg(p.creationTimes) * 100) / 100,
        p95CreateMs: Math.round(p95(p.creationTimes) * 100) / 100,
        avgLinkAddMs: Math.round(avg(p.linkTimes) * 100) / 100,
        p95LinkAddMs: Math.round(p95(p.linkTimes) * 100) / 100,
        rssKb: p.rssKb,
      })),
      rssSnapshots,
      totalPerspectivesCreated: totalPerspectives,
      totalLinksAdded: totalPerspectives * LINKS_PER_PERSPECTIVE,
      rssGrowthKb: rssSnapshots.length >= 2
        ? rssSnapshots[rssSnapshots.length - 1].rssKb - rssSnapshots[0].rssKb
        : null,
    };

    const lastPhase = phaseResults[phaseResults.length - 1];
    const firstPhase = phaseResults[0];
    const degradation = avg(firstPhase.creationTimes) > 0
      ? avg(lastPhase.creationTimes) / avg(firstPhase.creationTimes)
      : 1;

    return {
      scenario: "s3-perspective-scaling",
      branch,
      startTime,
      endTime,
      durationMs: totalMs,
      passed: true,
      metrics,
      samples,
      summary: `Created ${totalPerspectives} perspectives. Avg create time: ${avg(lastPhase.creationTimes).toFixed(1)}ms at 100 perspectives (${degradation.toFixed(2)}x degradation from 10). RSS growth: ${metrics.rssGrowthKb ? `${(metrics.rssGrowthKb / 1024).toFixed(1)}MB` : "N/A"}`,
    };
  },
};
