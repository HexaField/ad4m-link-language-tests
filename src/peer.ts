/**
 * WebRTC peer driver for SFU + mesh scenarios.
 *
 * Uses `@roamhq/wrtc` (a Node-native libwebrtc binding) so scenarios can
 * spawn N peers from a single test process without a browser harness.
 * The peer:
 *
 * - Generates a synthetic outbound stream (counter video, tone audio).
 *   Counter video lets us spot frame drops (the counter skips); the
 *   per-peer audio tone frequency lets the receiver verify active-speaker
 *   selection by reading received track energy.
 *
 * - Tracks `RTCPeerConnection.getStats()` at 1Hz, surfacing the inbound /
 *   outbound RTP and candidate-pair details that the scenarios assert on
 *   (bandwidth per peer, RTT, packet loss, simulcast layer in use).
 *
 * - Emits `'remote-track'`, `'ice-state'`, `'stats'` events for the
 *   scenario harness.
 *
 * The driver is signalling-agnostic: scenarios pass SDP between peers
 * (mesh) or to the executor SFU (T-series).  The peer itself just
 * owns its `RTCPeerConnection` lifecycle.
 */

import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

// `@roamhq/wrtc` is the Node-native libwebrtc binding.  When it's not
// installed the scenarios fail at scenario-run time (not import time)
// with a clear error pointing at `npm install --include=optional`.
// We resolve it via `createRequire(import.meta.url)` because the wind
// tunnel project is ESM but `@roamhq/wrtc` exports CJS.
const require_ = createRequire(import.meta.url);
let wrtc: any;
try {
  wrtc = require_("@roamhq/wrtc");
} catch (_e) {
  wrtc = null;
}

export interface PeerStats {
  // Outbound (we are the sender)
  bytesSent: number;
  packetsSent: number;
  framesEncoded: number;
  // Inbound (we are the receiver) — totalled across all remote tracks
  bytesReceived: number;
  packetsReceived: number;
  packetsLost: number;
  jitter: number;
  framesDecoded: number;
  framesDropped: number;
  // Connection
  currentRoundTripTimeMs: number | null;
  selectedCandidatePair: string | null;
  /** "host" | "srflx" | "prflx" | "relay" — type of the local side of the nominated pair. */
  selectedLocalCandidateType: string | null;
  /** Same for the remote side. */
  selectedRemoteCandidateType: string | null;
  // For SFU scenarios
  simulcastLayerInUse: "f" | "h" | "q" | null;
}

// ---------------------------------------------------------------------------
// Goertzel filter — detect energy at a specific frequency in PCM samples.
//
// Returns the magnitude (unitless, proportional to amplitude²) for
// `targetHz` over `samples.length` samples at the given `sampleRate`.
// ---------------------------------------------------------------------------
export function goertzelMagnitude(
  samples: Int16Array,
  sampleRate: number,
  targetHz: number,
): number {
  const N = samples.length;
  if (N === 0) return 0;
  const k = Math.round((N * targetHz) / sampleRate);
  const w = (2 * Math.PI * k) / N;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < N; i++) {
    const s0 = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2);
}

/** Result of frequency detection on a single received audio track. */
export interface DetectedTone {
  /** Track ID (from the MediaStreamTrack). */
  trackId: string;
  /** Dominant frequency in Hz (highest Goertzel magnitude). */
  dominantHz: number;
  /** Goertzel magnitude at the dominant frequency. */
  magnitude: number;
  /** Total PCM samples analysed. */
  samplesAnalysed: number;
}

/**
 * Accumulates raw PCM from an RTCAudioSink and runs Goertzel detection
 * against a set of candidate frequencies once enough samples arrive.
 */
class AudioFingerprinter {
  private sink: any;
  private buffer: Int16Array[] = [];
  private totalSamples = 0;
  private readonly candidateHz: number[];
  private readonly sampleRate = 48000;
  /** Accumulate at least this many samples before analysing (~0.5s). */
  private readonly minSamples = 24000;
  private _result: { hz: number; magnitude: number } | null = null;

  constructor(track: any, candidateHz: number[], wrtcImpl: any) {
    this.candidateHz = candidateHz;
    const { RTCAudioSink } = wrtcImpl.nonstandard;
    this.sink = new RTCAudioSink(track);
    this.sink.ondata = (data: {
      samples: Int16Array;
      sampleRate: number;
    }) => {
      if (this._result) return; // already resolved
      this.buffer.push(new Int16Array(data.samples)); // copy — the buffer gets reused
      this.totalSamples += data.samples.length;
      if (this.totalSamples >= this.minSamples) {
        this.analyse();
      }
    };
  }

  private analyse(): void {
    // Concatenate buffered frames into one contiguous array.
    const all = new Int16Array(this.totalSamples);
    let offset = 0;
    for (const chunk of this.buffer) {
      all.set(chunk, offset);
      offset += chunk.length;
    }
    this.buffer = []; // free memory

    let bestHz = 0;
    let bestMag = 0;
    for (const hz of this.candidateHz) {
      const mag = goertzelMagnitude(all, this.sampleRate, hz);
      if (mag > bestMag) {
        bestMag = mag;
        bestHz = hz;
      }
    }
    this._result = { hz: bestHz, magnitude: bestMag };
  }

  get result(): { hz: number; magnitude: number } | null {
    return this._result;
  }

  get samplesCollected(): number {
    return this.totalSamples;
  }

  stop(): void {
    if (!this.sink.stopped) this.sink.stop();
  }
}

export interface PeerOptions {
  /** Audio tone in Hz so receivers can identify the speaker. */
  audioToneHz?: number;
  /** Frame rate for the counter video. */
  videoFps?: number;
  /** ICE servers — defaults to Google STUN. */
  iceServers?: RTCIceServer[];
  /** ICE transport policy — "all" (default) or "relay" (force TURN). */
  iceTransportPolicy?: "all" | "relay";
  /**
   * Pre-allocate this many recv-only audio + video transceivers in the
   * initial offer.  The SFU's server-pushed renegotiation pipeline is
   * not wired into the wind tunnel client; without these slots,
   * remote peers' forwarded tracks have nowhere to land and
   * downloadMean stays at 0.  Set to (max-room-size - 1) on SFU
   * scenarios to surface the actual incoming bitrate.
   */
  recvSlots?: number;
  /** `wrtc` module override (for tests). */
  wrtcImpl?: any;
}

export class WebRtcPeer extends EventEmitter {
  readonly id: string;
  private pc: RTCPeerConnection;
  private localStream: MediaStream | null = null;
  private statsTimer: NodeJS.Timeout | null = null;
  private firstFrameAt: number | null = null;
  private lastStats: PeerStats | null = null;
  private fingerprinters: AudioFingerprinter[] = [];
  private fingerprintCandidates: number[] | null = null;
  private wrtcImpl: any;

  constructor(id: string, opts: PeerOptions = {}) {
    super();
    this.id = id;
    const impl = opts.wrtcImpl ?? wrtc;
    this.wrtcImpl = impl;
    if (!impl) {
      throw new Error(
        "WebRtcPeer: @roamhq/wrtc not available. Run `npm install --include=optional @roamhq/wrtc` " +
          "to enable the WebRTC scenarios.",
      );
    }
    const { RTCPeerConnection } = impl;
    this.pc = new RTCPeerConnection({
      iceServers: opts.iceServers ?? [{ urls: "stun:stun.l.google.com:19302" }],
      iceTransportPolicy: opts.iceTransportPolicy ?? "all",
    } as any);
    this.pc.addEventListener("track", (event: any) => {
      if (this.firstFrameAt === null) this.firstFrameAt = Date.now();
      this.emit("remote-track", { track: event.track, streams: event.streams });
      // Auto-fingerprint audio tracks when enabled.
      if (
        this.fingerprintCandidates &&
        event.track &&
        event.track.kind === "audio"
      ) {
        const fp = new AudioFingerprinter(
          event.track,
          this.fingerprintCandidates,
          this.wrtcImpl,
        );
        this.fingerprinters.push(fp);
      }
    });
    this.pc.addEventListener("iceconnectionstatechange", () => {
      this.emit("ice-state", this.pc.iceConnectionState);
    });
  }

  /**
   * Enable audio fingerprinting on all future received audio tracks.
   * Pass the list of candidate frequencies (the tone Hz values used by
   * each peer in the room).  Call BEFORE media starts flowing.
   */
  enableAudioFingerprinting(candidateHz: number[]): void {
    this.fingerprintCandidates = candidateHz;
  }

  /**
   * Return frequency detection results for every received audio track.
   * Each entry maps a received track to the dominant frequency detected
   * in its PCM stream.  Returns only tracks that have collected enough
   * samples for analysis (~0.5s of audio).
   */
  getDetectedTones(): DetectedTone[] {
    const tones: DetectedTone[] = [];
    for (const fp of this.fingerprinters) {
      const r = fp.result;
      if (r) {
        tones.push({
          trackId: `track-${tones.length}`,
          dominantHz: r.hz,
          magnitude: r.magnitude,
          samplesAnalysed: fp.samplesCollected,
        });
      }
    }
    return tones;
  }

  /**
   * Generate and attach a synthetic outbound stream.  When `@roamhq/wrtc`
   * is available we use its `nonstandard.RTCAudioSource` / `RTCVideoSource`
   * to drive media without a real camera/microphone.
   */
  async attachSyntheticStream(opts: PeerOptions = {}): Promise<void> {
    const impl = opts.wrtcImpl ?? wrtc;
    if (!impl?.nonstandard) {
      throw new Error("WebRtcPeer: synthetic media requires @roamhq/wrtc nonstandard sources.");
    }
    const { RTCAudioSource, RTCVideoSource } = impl.nonstandard;

    // 32-bit PCM tone — 48 kHz, 10ms frames.
    const audioSource = new RTCAudioSource();
    const audioTrack = audioSource.createTrack();
    const audioToneHz = opts.audioToneHz ?? 440;
    const sampleRate = 48000;
    const samplesPerFrame = sampleRate / 100; // 10ms
    let t = 0;
    const audioTimer = setInterval(() => {
      const samples = new Int16Array(samplesPerFrame);
      for (let i = 0; i < samplesPerFrame; i++) {
        samples[i] = Math.round(Math.sin(2 * Math.PI * audioToneHz * t) * 8000);
        t += 1 / sampleRate;
      }
      audioSource.onData({
        samples,
        sampleRate,
        bitsPerSample: 16,
        channelCount: 1,
        numberOfFrames: samplesPerFrame,
      });
    }, 10);

    // Counter video — 320x240 I420.
    const videoSource = new RTCVideoSource();
    const videoTrack = videoSource.createTrack();
    const fps = opts.videoFps ?? 15;
    const width = 320;
    const height = 240;
    const frameInterval = Math.round(1000 / fps);
    let frameCounter = 0;
    const yLen = width * height;
    const uvLen = (width / 2) * (height / 2);
    const videoTimer = setInterval(() => {
      const data = new Uint8Array(yLen + 2 * uvLen);
      // Brightness ramps with the counter so the receiver can detect
      // frame skips (the average pixel value should be monotonically
      // changing modulo 256).
      data.fill(frameCounter & 0xff, 0, yLen);
      data.fill(128, yLen, yLen + uvLen); // U
      data.fill(128, yLen + uvLen, yLen + 2 * uvLen); // V
      videoSource.onFrame({ width, height, data });
      frameCounter++;
    }, frameInterval);

    // Construct the MediaStream by adding tracks individually (the
    // wrtc shim exposes MediaStream on `impl.MediaStream`).
    const stream = new impl.MediaStream();
    stream.addTrack(audioTrack);
    stream.addTrack(videoTrack);
    this.localStream = stream;
    this.pc.addTrack(audioTrack, stream);
    this.pc.addTrack(videoTrack, stream);

    // Pre-allocate recv-only transceivers if requested.  Each slot is
    // one audio + one video m-line in the initial offer; the SFU's
    // answer matches these and forwarding to them works without a
    // renegotiation round-trip from the server.
    const recvSlots = opts.recvSlots ?? 0;
    for (let i = 0; i < recvSlots; i++) {
      try {
        (this.pc as any).addTransceiver?.("audio", { direction: "recvonly" });
        (this.pc as any).addTransceiver?.("video", { direction: "recvonly" });
      } catch {
        // Some @roamhq/wrtc versions ignore addTransceiver; safe to
        // skip — the scenarios will fall back to downloadMean=0.
      }
    }

    // Hold timers so they live for the peer's lifetime.
    (this as any)._audioTimer = audioTimer;
    (this as any)._videoTimer = videoTimer;
  }

  /** Create an SDP offer (caller side). */
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  /** Accept an SDP offer and produce an answer (callee side). */
  async createAnswer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    await this.pc.setRemoteDescription(offer);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  /** Apply an SDP answer (caller side, after createOffer + signalling). */
  async acceptAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(answer);
  }

  /** Begin 1Hz `getStats()` sampling.  Emits `'stats'` events. */
  startStats(): void {
    if (this.statsTimer) return;
    this.statsTimer = setInterval(async () => {
      try {
        const reports = await this.pc.getStats();
        const aggregated = aggregateStats(reports);
        this.lastStats = aggregated;
        this.emit("stats", aggregated);
      } catch (e) {
        this.emit("stats-error", e);
      }
    }, 1000);
  }

  stopStats(): void {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  getLastStats(): PeerStats | null {
    return this.lastStats;
  }

  /** Time from peer construction to first remote-track event, or null. */
  getFirstFrameAt(): number | null {
    return this.firstFrameAt;
  }

  /** Internal: expose the underlying RTCPeerConnection for harness use only. */
  peerConnection(): RTCPeerConnection {
    return this.pc;
  }

  async close(): Promise<void> {
    this.stopStats();
    for (const fp of this.fingerprinters) fp.stop();
    this.fingerprinters = [];
    const at = (this as any)._audioTimer;
    const vt = (this as any)._videoTimer;
    if (at) clearInterval(at);
    if (vt) clearInterval(vt);
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) track.stop();
    }
    this.pc.close();
  }
}

/** Roll up the noisy getStats() report into a single flat snapshot. */
function aggregateStats(reports: Map<string, any>): PeerStats {
  const stats: PeerStats = {
    bytesSent: 0,
    packetsSent: 0,
    framesEncoded: 0,
    bytesReceived: 0,
    packetsReceived: 0,
    packetsLost: 0,
    jitter: 0,
    framesDecoded: 0,
    framesDropped: 0,
    currentRoundTripTimeMs: null,
    selectedCandidatePair: null,
    selectedLocalCandidateType: null,
    selectedRemoteCandidateType: null,
    simulcastLayerInUse: null,
  };

  // Resolve candidate types by chasing localCandidateId / remoteCandidateId
  // through the report map after the loop.
  let localCandidateId: string | null = null;
  let remoteCandidateId: string | null = null;
  let inboundRtpCount = 0;
  for (const report of reports.values()) {
    if (report.type === "outbound-rtp") {
      stats.bytesSent += report.bytesSent ?? 0;
      stats.packetsSent += report.packetsSent ?? 0;
      stats.framesEncoded += report.framesEncoded ?? 0;
      if (report.rid) {
        stats.simulcastLayerInUse =
          (report.rid as "f" | "h" | "q") ?? stats.simulcastLayerInUse;
      }
    } else if (report.type === "inbound-rtp") {
      stats.bytesReceived += report.bytesReceived ?? 0;
      stats.packetsReceived += report.packetsReceived ?? 0;
      stats.packetsLost += report.packetsLost ?? 0;
      stats.jitter += report.jitter ?? 0;
      inboundRtpCount++;
      stats.framesDecoded += report.framesDecoded ?? 0;
      stats.framesDropped += report.framesDropped ?? 0;
    } else if (report.type === "candidate-pair" && report.nominated) {
      stats.currentRoundTripTimeMs =
        report.currentRoundTripTime != null ? report.currentRoundTripTime * 1000 : null;
      stats.selectedCandidatePair = `${report.localCandidateId}↔${report.remoteCandidateId}`;
      localCandidateId = report.localCandidateId ?? null;
      remoteCandidateId = report.remoteCandidateId ?? null;
    }
  }
  // Average jitter across inbound-rtp reports (not sum).
  if (inboundRtpCount > 1) {
    stats.jitter /= inboundRtpCount;
  }
  if (localCandidateId) {
    const lc = reports.get(localCandidateId);
    stats.selectedLocalCandidateType = lc?.candidateType ?? null;
  }
  if (remoteCandidateId) {
    const rc = reports.get(remoteCandidateId);
    stats.selectedRemoteCandidateType = rc?.candidateType ?? null;
  }
  return stats;
}

/** Manual SDP + ICE exchange between two peers — the mesh signalling helper.
 *
 * Trickle ICE: each peer's local candidates get added to the other peer's
 * connection as they arrive.  Without this the SDP advertises no
 * candidates and the peers never establish a media path (you see
 * `iceConnectionState === "checking"` indefinitely and zero bytes flow). */
export async function pairPeers(a: WebRtcPeer, b: WebRtcPeer): Promise<void> {
  a.peerConnection().addEventListener("icecandidate", (ev: any) => {
    if (ev.candidate) {
      b.peerConnection()
        .addIceCandidate(ev.candidate)
        .catch((e: any) => a.emit("ice-error", e));
    }
  });
  b.peerConnection().addEventListener("icecandidate", (ev: any) => {
    if (ev.candidate) {
      a.peerConnection()
        .addIceCandidate(ev.candidate)
        .catch((e: any) => b.emit("ice-error", e));
    }
  });

  const offer = await a.createOffer();
  const answer = await b.createAnswer(offer);
  await a.acceptAnswer(answer);
}
