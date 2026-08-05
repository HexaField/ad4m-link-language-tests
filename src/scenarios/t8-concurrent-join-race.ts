/**
 * T8: Concurrent join renegotiation race.
 *
 * Joins 5 peers to a single-node SFU room SIMULTANEOUSLY via
 * `Promise.all` and verifies the renegotiation pipeline handles the
 * burst:
 *
 *   1. Start a single-node SFU room.
 *   2. Provision 5 peers, attach streams, wire renegotiation.
 *   3. Fire all 5 callJoin requests via `Promise.all`.
 *   4. Wait for server participant count = 5.
 *   5. Wait for renegotiation to settle — each peer should receive
 *      offers for all other peers (>= 4 per peer).
 *   6. Count total renegotiations applied.
 *   7. Report any peers that got stuck (never received all tracks).
 *
 * The race between concurrent joins and server-pushed renegotiation
 * offers is real: a peer whose RTCPeerConnection is still in
 * "have-local-offer" state (waiting for the callJoin answer) cannot
 * apply a server renegotiation offer.  The scenario surfaces whether
 * the SFU recovers from this or leaves peers permanently stuck.
 */

import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import { WebRtcPeer } from "../peer.js";
import { provisionPeers, disconnectPeers } from "../users.js";
import { wireRenegotiation, RenegotiationWire } from "../renegotiation.js";

const ROOM_NAME = "t8-concurrent-join";
const NEIGHBOURHOOD = `windtunnel://t8`;
const PEER_COUNT = 5;
const SETTLE_TIMEOUT_MS = 20_000;

export const t8ConcurrentJoinRace: Scenario = {
  id: "t8",
  name: "Concurrent join renegotiation race",
  description:
    "5 peers join a single-node SFU room simultaneously — verifies " +
    "renegotiation pipeline handles the burst without dropping peers",

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client: admin, branch, port } = ctx;
    const startTime = Date.now();
    const samples: ScenarioResult["samples"] = [];
    const metrics: Record<string, unknown> = {};

    await admin.call("sfu.startRoom", {
      neighbourhoodUrl: NEIGHBOURHOOD,
      roomName: ROOM_NAME,
    });

    const sessions = await provisionPeers({
      admin,
      port,
      count: PEER_COUNT,
      labelPrefix: "t8-peer",
    });

    const peers: WebRtcPeer[] = [];
    const wires: RenegotiationWire[] = [];

    try {
      // Phase 1: prepare all peers — attach streams, wire renegotiation,
      // create offers.  Preparation happens sequentially so every event
      // subscription exists before the concurrent burst.
      const offers: Array<{ type: string; sdp?: string }> = [];
      for (let i = 0; i < sessions.length; i++) {
        const session = sessions[i];
        const peer = new WebRtcPeer(session.label, {
          audioToneHz: 440 + i * 40,
        });
        await peer.attachSyntheticStream();
        peers.push(peer);

        const wire = await wireRenegotiation({
          client: session.client,
          peer,
          token: session.token,
          port,
          neighbourhoodUrl: NEIGHBOURHOOD,
          roomName: ROOM_NAME,
        });
        wires.push(wire);

        const offer = await peer.createOffer();
        offers.push(offer);
      }

      // Phase 2: fire ALL callJoin requests simultaneously.
      const joinStart = Date.now();
      const joinResults = await Promise.all(
        sessions.map((session, i) =>
          session.client
            .call<{
              sdpAnswer: string;
              participantId: string;
              redirectTo?: string;
              streamMapping: string[];
            }>("sfu.callJoin", {
              neighbourhoodUrl: NEIGHBOURHOOD,
              roomName: ROOM_NAME,
              sdpOffer: JSON.stringify(offers[i]),
            })
            .then((resp) => ({
              idx: i,
              resp,
              error: null as string | null,
            }))
            .catch((e) => ({
              idx: i,
              resp: null as any,
              error: e instanceof Error ? e.message : String(e),
            })),
        ),
      );
      const joinElapsed = Date.now() - joinStart;
      samples.push({
        name: "concurrent_join_burst",
        durationMs: joinElapsed,
        timestamp: Date.now(),
      });

      // Accept answers for successful joins.
      const joinErrors: string[] = [];
      let successfulJoins = 0;
      for (const result of joinResults) {
        if (result.error) {
          joinErrors.push(`peer-${result.idx}: ${result.error}`);
          continue;
        }
        await peers[result.idx].acceptAnswer(
          JSON.parse(result.resp.sdpAnswer),
        );
        successfulJoins++;
      }
      metrics["joinErrors"] = joinErrors;
      metrics["successfulJoins"] = successfulJoins;

      // Phase 3: wait for server to report the expected participant count.
      const countStart = Date.now();
      let serverCount = 0;
      while (Date.now() - countStart < 15_000) {
        const rooms = await admin
          .call<Array<{ roomName: string; participantCount: number }>>(
            "sfu.listRooms",
            {},
          )
          .catch(
            () => [] as Array<{ roomName: string; participantCount: number }>,
          );
        const room = rooms.find((r) => r.roomName === ROOM_NAME);
        serverCount = room?.participantCount ?? 0;
        if (serverCount >= successfulJoins) break;
        await sleep(250);
      }
      metrics["serverParticipantCount"] = serverCount;

      // Phase 4: wait for renegotiations to settle.  Each peer should
      // receive renegotiation offers for every other peer (>= N-1).
      const expectedRenegotiations = Math.max(successfulJoins - 1, 0);
      const settleStart = Date.now();
      while (Date.now() - settleStart < SETTLE_TIMEOUT_MS) {
        const counts = wires.map((w) => w.count());
        if (counts.every((c) => c >= expectedRenegotiations)) break;
        await sleep(500);
      }
      const settleElapsed = Date.now() - settleStart;
      samples.push({
        name: "renegotiation_settle",
        durationMs: settleElapsed,
        timestamp: Date.now(),
      });

      const renegotiationCounts = wires.map((w) => w.count());
      metrics["renegotiationsPerPeer"] = renegotiationCounts;
      metrics["totalRenegotiations"] = renegotiationCounts.reduce(
        (a, b) => a + b,
        0,
      );
      metrics["expectedPerPeer"] = expectedRenegotiations;

      // Identify stuck peers: any peer with fewer renegotiations than
      // expected.
      const stuckPeers = renegotiationCounts
        .map((c, i) => ({ peer: i, count: c }))
        .filter((p) => p.count < expectedRenegotiations);
      metrics["stuckPeers"] = stuckPeers;
      metrics["allPeersSettled"] = stuckPeers.length === 0;
    } finally {
      for (const w of wires) {
        try {
          await w.detach();
        } catch {
          /* best-effort */
        }
      }
      for (let i = 0; i < peers.length; i++) {
        try {
          await sessions[i].client.call("sfu.callLeave", {
            neighbourhoodUrl: NEIGHBOURHOOD,
            roomName: ROOM_NAME,
          });
        } catch {
          /* best-effort */
        }
        try {
          await peers[i].close();
        } catch {
          /* best-effort */
        }
      }
      try {
        await admin.call("sfu.stopRoom", {
          neighbourhoodUrl: NEIGHBOURHOOD,
          roomName: ROOM_NAME,
        });
      } catch {
        /* best-effort */
      }
      await disconnectPeers(sessions);
    }

    const endTime = Date.now();
    return {
      scenario: "t8-concurrent-join-race",
      branch,
      startTime,
      endTime,
      durationMs: endTime - startTime,
      metrics,
      samples,
      summary:
        `T8: concurrent join — joined=${metrics["successfulJoins"]}/${PEER_COUNT} ` +
        `renegotiations=[${(metrics["renegotiationsPerPeer"] as number[]).join(",")}] ` +
        `(expected>=${metrics["expectedPerPeer"]}/peer) ` +
        `stuck=${(metrics["stuckPeers"] as any[]).length} ` +
        `allSettled=${metrics["allPeersSettled"]}`,
    };
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
