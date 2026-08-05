/**
 * S1: Cold Start Scenario
 * Measures time from executor start to first successful operations.
 * This scenario assumes the executor is already running (started by the runner).
 * It measures: health check latency, agent generation, first perspective creation, first link add.
 */

import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";

export const s1ColdStart: Scenario = {
  id: "s1",
  name: "Cold Start",
  description: "Measures time from executor availability to first successful operations",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, branch } = ctx;
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];

    // 1. Health check
    const health = await client.health();
    samples.push({ name: "health_check", durationMs: health.durationMs, timestamp: health.timestamp, error: health.error });

    // 2. Generate agent
    const agent = await client.generateAgent("wind-tunnel-passphrase");
    samples.push({ name: "agent_generate", durationMs: agent.durationMs, timestamp: agent.timestamp, error: agent.error });

    if (agent.error) {
      return {
        scenario: "s1-cold-start",
        branch,
        startTime,
        endTime: Date.now(),
        durationMs: Date.now() - startTime,
        passed: false,
        metrics: { healthMs: health.durationMs, agentGenerateMs: agent.durationMs, error: agent.error },
        samples,
        summary: `Cold start FAILED at agent generation: ${agent.error}`,
      };
    }

    // 3. Create first perspective
    const perspective = await client.createPerspective("wind-tunnel-cold-start");
    samples.push({ name: "first_perspective_create", durationMs: perspective.durationMs, timestamp: perspective.timestamp, error: perspective.error });

    if (perspective.error) {
      return {
        scenario: "s1-cold-start",
        branch,
        startTime,
        endTime: Date.now(),
        durationMs: Date.now() - startTime,
        passed: false,
        metrics: { healthMs: health.durationMs, agentGenerateMs: agent.durationMs, perspectiveCreateMs: perspective.durationMs, error: perspective.error },
        samples,
        summary: `Cold start FAILED at perspective creation: ${perspective.error}`,
      };
    }

    const uuid = perspective.data?.uuid || perspective.data?.id;

    // 4. Add first link
    const link = await client.addLink(
      uuid,
      "ad4m://cold-start-test",
      "ad4m://has",
      "literal://first-link"
    );
    samples.push({ name: "first_link_add", durationMs: link.durationMs, timestamp: link.timestamp, error: link.error });

    // 5. Query first link
    const query = await client.queryLinks(uuid, { source: "ad4m://cold-start-test" });
    samples.push({ name: "first_link_query", durationMs: query.durationMs, timestamp: query.timestamp, error: query.error });

    const endTime = Date.now();
    const totalMs = endTime - startTime;

    const metrics = {
      healthMs: health.durationMs,
      agentGenerateMs: agent.durationMs,
      firstPerspectiveCreateMs: perspective.durationMs,
      firstLinkAddMs: link.durationMs,
      firstLinkQueryMs: query.durationMs,
      totalColdStartMs: totalMs,
    };

    return {
      scenario: "s1-cold-start",
      branch,
      startTime,
      endTime,
      durationMs: totalMs,
      passed: true,
      metrics,
      samples,
      summary: `Cold start complete in ${totalMs}ms (health: ${health.durationMs.toFixed(0)}ms, agent: ${agent.durationMs.toFixed(0)}ms, perspective: ${perspective.durationMs.toFixed(0)}ms, link: ${link.durationMs.toFixed(0)}ms, query: ${query.durationMs.toFixed(0)}ms)`,
    };
  },
};
