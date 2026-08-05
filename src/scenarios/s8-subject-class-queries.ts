/**
 * S8: Subject Class Queries
 * Simulates a realistic Flux community graph and benchmarks production SPARQL patterns.
 * Falls back to link query patterns if SPARQL is not available on the branch.
 */

import { execSync } from "child_process";
import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import { InstrumentedClient } from "../client.js";

// Flux ontology predicates
const PREDICATES = {
  ENTRY_TYPE: "flux://entry_type",
  BODY: "flux://body",
  CHANNEL_NAME: "flux://has_channel_name",
  CHANNEL_DESCRIPTION: "flux://has_channel_description",
  CHANNEL_IS_CONVERSATION: "flux://channel_is_conversation",
  CHANNEL_IS_PINNED: "flux://channel_is_pinned",
  HAS_CHILD: "ad4m://has_child",
  HAS_REACTION: "flux://has_reaction",
  HAS_REPLY: "flux://has_reply",
  MESSAGE_THREAD: "flux://has_thread_message",
  SUBGROUP_ITEM: "flux://has_item",
  PARTICIPANT: "flux://has_participant",
  CONVERSATION: "flux://has_conversation",
  CONVERSATION_SUBGROUP: "flux://has_subgroup",
  TOPIC: "flux://topic",
  HAS_TAG: "flux://has_tag",
  SEMANTIC_REL_TYPE: "flux://has_semantic_relationship",
  HAS_RELEVANCE: "flux://has_relevance",
  AUTHOR: "ad4m://ontology/author",
  TIMESTAMP: "ad4m://ontology/timestamp",
};

const ENTRY_TYPES = {
  Channel: "flux://has_channel",
  Message: "flux://has_message",
  Post: "flux://has_post",
  Conversation: "flux://conversation",
  ConversationSubgroup: "flux://conversation_subgroup",
  Topic: "flux://has_topic",
  SemanticRelationship: "flux://has_semantic_relationship",
};

interface TierConfig {
  name: string;
  channels: number;
  messagesPerChannel: number;
  conversationsPerChannel: number;
  subgroupsPerConversation: number;
  reactionsPerMessage: number;
  repliesRatio: number; // fraction of messages that are replies
  topicsPerSubgroup: number;
}

const TIERS: TierConfig[] = [
  {
    name: "small",
    channels: 3,
    messagesPerChannel: 100,
    conversationsPerChannel: 2,
    subgroupsPerConversation: 2,
    reactionsPerMessage: 1,
    repliesRatio: 0.3,
    topicsPerSubgroup: 2,
  },
  {
    name: "medium",
    channels: 5,
    messagesPerChannel: 2000,
    conversationsPerChannel: 5,
    subgroupsPerConversation: 3,
    reactionsPerMessage: 2,
    repliesRatio: 0.3,
    topicsPerSubgroup: 3,
  },
  {
    name: "large",
    channels: 5,
    messagesPerChannel: 20000,
    conversationsPerChannel: 10,
    subgroupsPerConversation: 4,
    reactionsPerMessage: 2,
    repliesRatio: 0.3,
    topicsPerSubgroup: 4,
  },
];

// SPARQL queries from Flux
const SPARQL_QUERIES = {
  totalItemCount: (channelId: string) => `
    SELECT (COUNT(DISTINCT ?item) as ?count)
    WHERE {
      <${channelId}> <${PREDICATES.HAS_CHILD}> ?item .
      ?item <${PREDICATES.ENTRY_TYPE}> ?type .
      FILTER(?type IN (<${ENTRY_TYPES.Message}>, <${ENTRY_TYPES.Post}>))
    }
  `,

  allItems: (channelId: string) => `
    SELECT ?item ?type ?body ?author ?timestamp
    WHERE {
      <${channelId}> <${PREDICATES.HAS_CHILD}> ?item .
      ?item <${PREDICATES.ENTRY_TYPE}> ?type .
      OPTIONAL { ?item <${PREDICATES.BODY}> ?body . }
      OPTIONAL { ?item <${PREDICATES.AUTHOR}> ?author . }
      OPTIONAL { ?item <${PREDICATES.TIMESTAMP}> ?timestamp . }
      FILTER(?type IN (<${ENTRY_TYPES.Message}>, <${ENTRY_TYPES.Post}>))
    }
  `,

  unprocessedItems: (channelId: string) => `
    SELECT ?item
    WHERE {
      <${channelId}> <${PREDICATES.HAS_CHILD}> ?item .
      ?item <${PREDICATES.ENTRY_TYPE}> <${ENTRY_TYPES.Message}> .
      FILTER NOT EXISTS {
        ?subgroup <${PREDICATES.SUBGROUP_ITEM}> ?item .
      }
    }
  `,

  recentConversations: (channelId: string) => `
    SELECT ?conv (MAX(?ts) as ?lastActivity)
    WHERE {
      <${channelId}> <${PREDICATES.CONVERSATION}> ?conv .
      ?conv <${PREDICATES.CONVERSATION_SUBGROUP}> ?sg .
      ?sg <${PREDICATES.SUBGROUP_ITEM}> ?item .
      ?item <${PREDICATES.TIMESTAMP}> ?ts .
    }
    GROUP BY ?conv
    ORDER BY DESC(?lastActivity)
    LIMIT 5
  `,

  pinnedConversations: (channelId: string) => `
    SELECT ?conv
    WHERE {
      <${channelId}> <${PREDICATES.CONVERSATION}> ?conv .
      <${channelId}> <${PREDICATES.CHANNEL_IS_PINNED}> "true" .
    }
  `,

  subgroupItemsData: (subgroupId: string) => `
    SELECT ?item ?body ?author ?timestamp
    WHERE {
      <${subgroupId}> <${PREDICATES.SUBGROUP_ITEM}> ?item .
      OPTIONAL { ?item <${PREDICATES.BODY}> ?body . }
      OPTIONAL { ?item <${PREDICATES.AUTHOR}> ?author . }
      OPTIONAL { ?item <${PREDICATES.TIMESTAMP}> ?timestamp . }
    }
    ORDER BY ?timestamp
  `,

  subgroupTopics: (subgroupId: string) => `
    SELECT ?topic ?rel
    WHERE {
      <${subgroupId}> <${PREDICATES.TOPIC}> ?topic .
      OPTIONAL { <${subgroupId}> <${PREDICATES.SEMANTIC_REL_TYPE}> ?rel . }
    }
  `,

  messageHydration: (messageId: string) => `
    SELECT ?reaction ?reply ?threadMsg
    WHERE {
      OPTIONAL { <${messageId}> <${PREDICATES.HAS_REACTION}> ?reaction . }
      OPTIONAL { ?reply <${PREDICATES.HAS_REPLY}> <${messageId}> . }
      OPTIONAL { ?threadMsg <${PREDICATES.MESSAGE_THREAD}> <${messageId}> . }
    }
  `,

  paginatedMessages: (channelId: string, offset: number) => `
    SELECT ?item ?body ?timestamp
    WHERE {
      <${channelId}> <${PREDICATES.HAS_CHILD}> ?item .
      ?item <${PREDICATES.ENTRY_TYPE}> <${ENTRY_TYPES.Message}> .
      ?item <${PREDICATES.TIMESTAMP}> ?timestamp .
      OPTIONAL { ?item <${PREDICATES.BODY}> ?body . }
    }
    ORDER BY DESC(?timestamp)
    LIMIT 50
    OFFSET ${offset}
  `,
};

interface QueryBenchmark {
  queryName: string;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
  runs: number;
  errors: number;
  usedSparql: boolean;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function stats(latencies: number[]) {
  if (latencies.length === 0) return { avg: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0 };
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    avg: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p50: percentile(sorted, 0.50),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

export const s8SubjectClassQueries: Scenario = {
  id: "s8",
  name: "Subject Class Queries",
  description: "Benchmark production Flux SPARQL patterns against realistic community graph",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, branch, port } = ctx;
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];

    // Setup
    await client.generateAgent("wind-tunnel-subject-class");
    const perspective = await client.createPerspective("subject-class-bench");
    if (perspective.error) {
      return {
        scenario: "s8-subject-class-queries",
        branch,
        startTime,
        endTime: Date.now(),
        durationMs: Date.now() - startTime,
        passed: false,
        metrics: { error: perspective.error },
        samples,
        summary: `S8 FAILED: ${perspective.error}`,
      };
    }

    const uuid = perspective.data?.uuid || perspective.data?.id;

    // Check if SPARQL is available
    let sparqlAvailable = false;
    try {
      const testResult = await client.querySparql(uuid, "SELECT ?s WHERE { ?s ?p ?o } LIMIT 1");
      sparqlAvailable = !testResult.error;
    } catch {
      sparqlAvailable = false;
    }

    console.log(`[s8] SPARQL available: ${sparqlAvailable} (branch: ${branch})`);

    const tierResults: Record<string, { seedDurationMs: number; linkCount: number; queries: QueryBenchmark[] }> = {};

    // Run only small and medium tiers to keep time reasonable
    const tiersToRun = TIERS.slice(0, 2); // small and medium

    for (const tier of tiersToRun) {
      console.log(`[s8] Seeding ${tier.name} tier: ${tier.channels} channels × ${tier.messagesPerChannel} messages...`);

      // Create a fresh perspective for each tier
      const tierPerspective = await client.createPerspective(`s8-${tier.name}`);
      if (tierPerspective.error) {
        console.log(`[s8] Failed to create perspective for tier ${tier.name}: ${tierPerspective.error}`);
        continue;
      }
      const tierUuid = tierPerspective.data?.uuid || tierPerspective.data?.id;

      // Seed the graph
      const seedStart = performance.now();
      const graph = await seedGraph(client, tierUuid, tier);
      const seedDuration = performance.now() - seedStart;

      console.log(`[s8] Seeded ${tier.name} in ${(seedDuration / 1000).toFixed(1)}s (${graph.totalLinks} links)`);

      samples.push({
        name: `seed_${tier.name}`,
        durationMs: seedDuration,
        timestamp: Date.now(),
      });

      // Benchmark queries
      const queryResults: QueryBenchmark[] = [];
      const RUNS = 5; // Run each query 5 times

      // 1. totalItemCount
      queryResults.push(await benchmarkQuery(client, tierUuid, "totalItemCount", RUNS, sparqlAvailable, () => {
        if (sparqlAvailable) {
          return client.querySparql(tierUuid, SPARQL_QUERIES.totalItemCount(graph.channels[0]));
        }
        return client.queryLinks(tierUuid, { source: graph.channels[0], predicate: PREDICATES.HAS_CHILD });
      }));

      // 2. allItems
      queryResults.push(await benchmarkQuery(client, tierUuid, "allItems", RUNS, sparqlAvailable, () => {
        if (sparqlAvailable) {
          return client.querySparql(tierUuid, SPARQL_QUERIES.allItems(graph.channels[0]));
        }
        return client.queryLinks(tierUuid, { source: graph.channels[0], predicate: PREDICATES.HAS_CHILD });
      }));

      // 3. unprocessedItems
      queryResults.push(await benchmarkQuery(client, tierUuid, "unprocessedItems", RUNS, sparqlAvailable, () => {
        if (sparqlAvailable) {
          return client.querySparql(tierUuid, SPARQL_QUERIES.unprocessedItems(graph.channels[0]));
        }
        // Fallback: can't do set-difference with link queries alone
        return client.queryLinks(tierUuid, { source: graph.channels[0], predicate: PREDICATES.HAS_CHILD });
      }));

      // 4. recentConversations
      queryResults.push(await benchmarkQuery(client, tierUuid, "recentConversations", RUNS, sparqlAvailable, () => {
        if (sparqlAvailable) {
          return client.querySparql(tierUuid, SPARQL_QUERIES.recentConversations(graph.channels[0]));
        }
        return client.queryLinks(tierUuid, { source: graph.channels[0], predicate: PREDICATES.CONVERSATION });
      }));

      // 5. pinnedConversations
      queryResults.push(await benchmarkQuery(client, tierUuid, "pinnedConversations", RUNS, sparqlAvailable, () => {
        if (sparqlAvailable) {
          return client.querySparql(tierUuid, SPARQL_QUERIES.pinnedConversations(graph.channels[0]));
        }
        return client.queryLinks(tierUuid, { target: "true", predicate: PREDICATES.CHANNEL_IS_PINNED });
      }));

      // 6. subgroupItemsData
      if (graph.subgroups.length > 0) {
        queryResults.push(await benchmarkQuery(client, tierUuid, "subgroupItemsData", RUNS, sparqlAvailable, () => {
          if (sparqlAvailable) {
            return client.querySparql(tierUuid, SPARQL_QUERIES.subgroupItemsData(graph.subgroups[0]));
          }
          return client.queryLinks(tierUuid, { source: graph.subgroups[0], predicate: PREDICATES.SUBGROUP_ITEM });
        }));
      }

      // 7. subgroupTopics
      if (graph.subgroups.length > 0) {
        queryResults.push(await benchmarkQuery(client, tierUuid, "subgroupTopics", RUNS, sparqlAvailable, () => {
          if (sparqlAvailable) {
            return client.querySparql(tierUuid, SPARQL_QUERIES.subgroupTopics(graph.subgroups[0]));
          }
          return client.queryLinks(tierUuid, { source: graph.subgroups[0], predicate: PREDICATES.TOPIC });
        }));
      }

      // 8. messageHydration
      if (graph.messages.length > 0) {
        queryResults.push(await benchmarkQuery(client, tierUuid, "messageHydration", RUNS, sparqlAvailable, () => {
          const msgId = graph.messages[Math.floor(Math.random() * Math.min(100, graph.messages.length))];
          if (sparqlAvailable) {
            return client.querySparql(tierUuid, SPARQL_QUERIES.messageHydration(msgId));
          }
          return client.queryLinks(tierUuid, { source: msgId });
        }));
      }

      // 9. paginatedMessages
      queryResults.push(await benchmarkQuery(client, tierUuid, "paginatedMessages", RUNS, sparqlAvailable, () => {
        if (sparqlAvailable) {
          return client.querySparql(tierUuid, SPARQL_QUERIES.paginatedMessages(graph.channels[0], 0));
        }
        return client.queryLinks(tierUuid, { source: graph.channels[0], predicate: PREDICATES.HAS_CHILD });
      }));

      tierResults[tier.name] = {
        seedDurationMs: Math.round(seedDuration),
        linkCount: graph.totalLinks,
        queries: queryResults,
      };

      for (const qr of queryResults) {
        samples.push({
          name: `query_${tier.name}_${qr.queryName}`,
          durationMs: qr.avgMs,
          timestamp: Date.now(),
        });
      }
    }

    const endTime = Date.now();
    const totalMs = endTime - startTime;

    const metrics = {
      sparqlAvailable,
      tiers: tierResults,
    };

    const summaryParts: string[] = [`SPARQL: ${sparqlAvailable ? "yes" : "no (link query fallback)"}`];
    for (const [tierName, tierData] of Object.entries(tierResults)) {
      const slowest = tierData.queries.reduce((a, b) => (a.avgMs > b.avgMs ? a : b), tierData.queries[0]);
      summaryParts.push(`${tierName}: ${tierData.linkCount} links, seed=${(tierData.seedDurationMs / 1000).toFixed(1)}s, slowest=${slowest?.queryName}@${slowest?.avgMs.toFixed(0)}ms`);
    }

    return {
      scenario: "s8-subject-class-queries",
      branch,
      startTime,
      endTime,
      durationMs: totalMs,
      passed: true,
      metrics,
      samples,
      summary: summaryParts.join(". "),
    };
  },
};

async function benchmarkQuery(
  client: InstrumentedClient,
  uuid: string,
  name: string,
  runs: number,
  sparqlUsed: boolean,
  queryFn: () => Promise<any>,
): Promise<QueryBenchmark> {
  const latencies: number[] = [];
  let errors = 0;

  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    try {
      const result = await queryFn();
      const duration = performance.now() - start;
      if (result.error) {
        errors++;
      }
      latencies.push(result.durationMs || duration);
    } catch (err) {
      errors++;
      latencies.push(performance.now() - start);
    }
  }

  const s = stats(latencies);
  return {
    queryName: name,
    avgMs: Math.round(s.avg * 100) / 100,
    p50Ms: Math.round(s.p50 * 100) / 100,
    p95Ms: Math.round(s.p95 * 100) / 100,
    p99Ms: Math.round(s.p99 * 100) / 100,
    minMs: Math.round(s.min * 100) / 100,
    maxMs: Math.round(s.max * 100) / 100,
    runs,
    errors,
    usedSparql: sparqlUsed,
  };
}

interface SeededGraph {
  channels: string[];
  messages: string[];
  conversations: string[];
  subgroups: string[];
  totalLinks: number;
}

async function seedGraph(
  client: InstrumentedClient,
  uuid: string,
  tier: TierConfig,
): Promise<SeededGraph> {
  const channels: string[] = [];
  const messages: string[] = [];
  const conversations: string[] = [];
  const subgroups: string[] = [];
  let totalLinks = 0;

  const authors = Array.from({ length: 10 }, (_, i) => `did:key:author${i}`);

  for (let ch = 0; ch < tier.channels; ch++) {
    const channelId = `ad4m://channel-${ch}`;
    channels.push(channelId);

    // Channel metadata
    await client.addLink(uuid, channelId, PREDICATES.ENTRY_TYPE, ENTRY_TYPES.Channel);
    await client.addLink(uuid, channelId, PREDICATES.CHANNEL_NAME, `literal://string:Channel ${ch}`);
    await client.addLink(uuid, channelId, PREDICATES.CHANNEL_IS_CONVERSATION, "true");
    await client.addLink(uuid, channelId, PREDICATES.CHANNEL_IS_PINNED, ch === 0 ? "true" : "false");
    totalLinks += 4;

    // Messages
    const channelMessages: string[] = [];
    for (let m = 0; m < tier.messagesPerChannel; m++) {
      const msgId = `ad4m://msg-${ch}-${m}`;
      channelMessages.push(msgId);
      messages.push(msgId);

      // Core link: channel -> message
      await client.addLink(uuid, channelId, PREDICATES.HAS_CHILD, msgId);
      await client.addLink(uuid, msgId, PREDICATES.ENTRY_TYPE, ENTRY_TYPES.Message);
      await client.addLink(uuid, msgId, PREDICATES.BODY, `literal://string:Message ${m} in channel ${ch}`);
      await client.addLink(uuid, msgId, PREDICATES.AUTHOR, authors[m % authors.length]);
      await client.addLink(uuid, msgId, PREDICATES.TIMESTAMP, `literal://string:${new Date(Date.now() - (tier.messagesPerChannel - m) * 60000).toISOString()}`);
      totalLinks += 5;

      // Reactions (simplified — only first few messages get reactions)
      if (m < tier.messagesPerChannel * 0.2) {
        for (let r = 0; r < Math.min(tier.reactionsPerMessage, 2); r++) {
          await client.addLink(uuid, msgId, PREDICATES.HAS_REACTION, `literal://string:👍`);
          totalLinks++;
        }
      }

      // Replies
      if (m > 0 && Math.random() < tier.repliesRatio) {
        const replyTo = channelMessages[Math.floor(Math.random() * m)];
        await client.addLink(uuid, msgId, PREDICATES.HAS_REPLY, replyTo);
        totalLinks++;
      }

      // Log progress for large tiers
      if (m > 0 && m % 500 === 0) {
        console.log(`[s8]   channel ${ch}: seeded ${m}/${tier.messagesPerChannel} messages`);
      }
    }

    // Conversations and subgroups
    for (let conv = 0; conv < tier.conversationsPerChannel; conv++) {
      const convId = `ad4m://conv-${ch}-${conv}`;
      conversations.push(convId);
      await client.addLink(uuid, channelId, PREDICATES.CONVERSATION, convId);
      await client.addLink(uuid, convId, PREDICATES.ENTRY_TYPE, ENTRY_TYPES.Conversation);
      totalLinks += 2;

      for (let sg = 0; sg < tier.subgroupsPerConversation; sg++) {
        const sgId = `ad4m://sg-${ch}-${conv}-${sg}`;
        subgroups.push(sgId);
        await client.addLink(uuid, convId, PREDICATES.CONVERSATION_SUBGROUP, sgId);
        await client.addLink(uuid, sgId, PREDICATES.ENTRY_TYPE, ENTRY_TYPES.ConversationSubgroup);
        totalLinks += 2;

        // Assign some messages to subgroup
        const startIdx = sg * Math.floor(channelMessages.length / tier.subgroupsPerConversation);
        const count = Math.min(10, Math.floor(channelMessages.length / tier.subgroupsPerConversation));
        for (let i = 0; i < count; i++) {
          const msgIdx = startIdx + i;
          if (msgIdx < channelMessages.length) {
            await client.addLink(uuid, sgId, PREDICATES.SUBGROUP_ITEM, channelMessages[msgIdx]);
            totalLinks++;
          }
        }

        // Topics
        for (let t = 0; t < tier.topicsPerSubgroup; t++) {
          const topicId = `ad4m://topic-${ch}-${conv}-${sg}-${t}`;
          await client.addLink(uuid, sgId, PREDICATES.TOPIC, topicId);
          await client.addLink(uuid, topicId, PREDICATES.ENTRY_TYPE, ENTRY_TYPES.Topic);
          totalLinks += 2;
        }
      }
    }
  }

  return { channels, messages, conversations, subgroups, totalLinks };
}
