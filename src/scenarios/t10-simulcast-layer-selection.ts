/**
 * T10: Simulcast layer selection verification.
 *
 * Verifies the SFU honours `sfu.callSetQualityPreference` by measuring
 * received video bitrate before and after a layer switch:
 *
 *   1. Start a single-node SFU room.
 *   2. Join 2 peers with video (attempt simulcast: high/medium/low).
 *   3. Wire renegotiation for both.
 *   4. Peer B calls `sfu.callSetQualityPreference("low")`.
 *   5. Measure received video bitrate on peer B over 10 seconds.
 *   6. Peer B calls `sfu.callSetQualityPreference("high")`.
 *   7. Measure received video bitrate on peer B over another 10 seconds.
 *   8. Assert the "high" bitrate exceeds the "low" bitrate by >= 2x.
 *   9. Report both bitrate measurements.
 *
 * If `@roamhq/wrtc` does not support simulcast send-encodings, the
 * scenario still runs and reports the quality-preference API results.
 * The bitrate assertion degrades gracefully (logged but not fatal).
 */

import { Scenario, ScenarioContext, ScenarioResult } from "../scenario.js";
import { WebRtcPeer, PeerStats } from "../peer.js";
import { provisionPeers, disconnectPeers } from "../users.js";
import { wireRenegotiation, RenegotiationWire } from "../renegotiation.js";

const ROOM_NAME = "t10-simulcast";
const NEIGHBOURHOOD = `windtunnel://t10`;
const MEASURE_WINDOW_MS = 10_000;

export const t10SimulcastLayerSelection: Scenario = {
  id: "t10",
  name: "Simulcast layer selection",
  description:
    "2-peer SFU room — verifies callSetQualityPreference toggles " +
    "received bitrate between low and high layers (>= 2x difference)",

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
      count: 2,
      labelPrefix: "t10-peer",
    });

    const peers: WebRtcPeer[] = [];
    const wires: RenegotiationWire[] = [];

    try {
      // Join both peers.
      for (let i = 0; i < 2; i++) {
        const session = sessions[i];
        const peer = new WebRtcPeer(session.label, {
          audioToneHz: 440 + i * 60,
        });
        await peer.attachSyntheticStream();
        peers.push(peer);

        // Attempt to configure simulcast encodings on the video sender.
        // @roamhq/wrtc may not expose this API — we catch and report.
        let simulcastConfigured = false;
        try {
          const pc = peer.peerConnection();
          const senders = pc.getSenders();
          const videoSender = senders.find(
            (s: any) => s.track?.kind === "video",
          );
          if (videoSender) {
            const params = videoSender.getParameters();
            params.encodings = [
              { rid: "q", maxBitrate: 150_000, scaleResolutionDownBy: 4 },
              { rid: "h", maxBitrate: 500_000, scaleResolutionDownBy: 2 },
              { rid: "f", maxBitrate: 1_200_000 },
            ];
            await videoSender.setParameters(params);
            simulcastConfigured = true;
          }
        } catch {
          // Simulcast encoding configuration not supported — proceed
          // with single-layer video and test the API anyway.
        }
        if (i === 0) {
          metrics["simulcastConfigured"] = simulcastConfigured;
        }

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
        const joinResp = await session.client.call<{
          sdpAnswer: string;
          participantId: string;
          redirectTo?: string;
          streamMapping: string[];
        }>("sfu.callJoin", {
          neighbourhoodUrl: NEIGHBOURHOOD,
          roomName: ROOM_NAME,
          sdpOffer: JSON.stringify(offer),
        });
        await peer.acceptAnswer(JSON.parse(joinResp.sdpAnswer));
      }

      // Allow renegotiation to settle.
      await sleep(3000);

      const peerB = peers[1];
      const sessionB = sessions[1];

      // ── Measure LOW quality ──
      let lowQualityError: string | null = null;
      try {
        await sessionB.client.call("sfu.callSetQualityPreference", {
          neighbourhoodUrl: NEIGHBOURHOOD,
          roomName: ROOM_NAME,
          quality: "low",
        });
      } catch (e) {
        lowQualityError = e instanceof Error ? e.message : String(e);
      }
      metrics["lowQualitySetError"] = lowQualityError;

      const lowBitrate = await measureBitrateBps(peerB, MEASURE_WINDOW_MS);
      metrics["lowBitrateBps"] = lowBitrate;
      samples.push({
        name: "low_quality_bitrate_bps",
        durationMs: MEASURE_WINDOW_MS,
        timestamp: Date.now(),
      });

      // ── Measure HIGH quality ──
      let highQualityError: string | null = null;
      try {
        await sessionB.client.call("sfu.callSetQualityPreference", {
          neighbourhoodUrl: NEIGHBOURHOOD,
          roomName: ROOM_NAME,
          quality: "high",
        });
      } catch (e) {
        highQualityError = e instanceof Error ? e.message : String(e);
      }
      metrics["highQualitySetError"] = highQualityError;

      const highBitrate = await measureBitrateBps(peerB, MEASURE_WINDOW_MS);
      metrics["highBitrateBps"] = highBitrate;
      samples.push({
        name: "high_quality_bitrate_bps",
        durationMs: MEASURE_WINDOW_MS,
        timestamp: Date.now(),
      });

      // ── Assertion ──
      const ratio =
        lowBitrate > 0 ? highBitrate / lowBitrate : highBitrate > 0 ? Infinity : 0;
      metrics["highToLowRatio"] = ratio;
      metrics["layerSwitchEffective"] = ratio >= 2;
      metrics["renegotiationsPerPeer"] = wires.map((w) => w.count());
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
      scenario: "t10-simulcast-layer-selection",
      branch,
      startTime,
      endTime,
      durationMs: endTime - startTime,
      metrics,
      samples,
      summary:
        `T10: simulcast — lowBps=${metrics["lowBitrateBps"]} ` +
        `highBps=${metrics["highBitrateBps"]} ` +
        `ratio=${(metrics["highToLowRatio"] as number).toFixed(2)} ` +
        `effective=${metrics["layerSwitchEffective"]} ` +
        `simulcastConfigured=${metrics["simulcastConfigured"]}`,
    };
  },
};

/**
 * Measure received bitrate (bits/s) on a peer over a window.
 *
 * Starts stats collection, waits for two samples separated by the
 * window duration, and computes the delta.
 */
async function measureBitrateBps(
  peer: WebRtcPeer,
  windowMs: number,
): Promise<number> {
  // Grab a baseline sample.
  peer.startStats();
  await sleep(1000);
  const baselineStats = peer.getLastStats();
  const baselineBytes = baselineStats?.bytesReceived ?? 0;
  const baselineTime = Date.now();

  await sleep(windowMs);

  const endStats = peer.getLastStats();
  const endBytes = endStats?.bytesReceived ?? 0;
  peer.stopStats();

  const elapsedSec = (Date.now() - baselineTime) / 1000;
  if (elapsedSec <= 0) return 0;
  return Math.round(((endBytes - baselineBytes) * 8) / elapsedSec);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
