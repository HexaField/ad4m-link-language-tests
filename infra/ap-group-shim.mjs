#!/usr/bin/env node
/**
 * AP group-actor shim — a dependency-free ActivityPub "group" server for the
 * wind-tunnel C1 convergence scenario.
 *
 * Real Fediverse groups (Lemmy / Guppe / Mobilizon) accept member activities at
 * the group inbox and re-publish them to the group outbox for every member to
 * pull. The follow/Accept handshake cannot complete co-located (neither executor
 * runs an HTTP inbox to receive the Accept), so this shim provides the group's
 * fan-out directly: POST an activity to the group inbox → it lands in the group
 * outbox → both agents pull it via the language's `syncFromOutbox`. This is
 * transport only; convergence is still decided by the language's
 * content-addressed diff-DAG fold, never by this server.
 *
 * Endpoints (per neighbourhood id :nid), matching the ap-link-language template
 * vars GROUP_ACTOR_URL=/ap/v1/groups/:nid, GROUP_INBOX_URL=.../inbox,
 * GROUP_OUTBOX_URL=.../outbox and the diff activity id .../diffs/:diffId:
 *
 *   GET  /                                 → 200 health
 *   GET  /ap/v1/groups/:nid                → Group actor document
 *   POST /ap/v1/groups/:nid/inbox          → accept an activity, reflect to outbox
 *   GET  /ap/v1/groups/:nid/outbox         → OrderedCollection of reflected items
 *   GET  /ap/v1/groups/:nid/diffs/:diffId  → the reflected diff activity (prev-walk)
 *   GET  /ap/v1/groups/:nid/followers      → empty OrderedCollection
 *
 * HTTP signatures are accepted without verification (co-located test rig).
 */

import http from "node:http";

const PORT = parseInt(process.env.AP_SHIM_PORT || "7791", 10);
const HOST = process.env.AP_SHIM_HOST || "127.0.0.1";

/** nid → { activityById: Map<id, activity>, order: id[], byDiffId: Map<diffId, activity> } */
const groups = new Map();

function groupFor(nid) {
  let g = groups.get(nid);
  if (!g) {
    g = { activityById: new Map(), order: [], byDiffId: new Map() };
    groups.set(nid, g);
  }
  return g;
}

function actorUrl(nid) {
  return `http://${HOST}:${PORT}/ap/v1/groups/${nid}`;
}

function actorDoc(nid) {
  const id = actorUrl(nid);
  return {
    "@context": ["https://www.w3.org/ns/activitystreams", "https://w3id.org/security/v1"],
    type: "Group",
    id,
    inbox: `${id}/inbox`,
    outbox: `${id}/outbox`,
    followers: `${id}/followers`,
    preferredUsername: nid,
    name: `AD4M neighbourhood ${nid}`,
    publicKey: {
      id: `${id}#main-key`,
      owner: id,
      publicKeyPem: "-----BEGIN PUBLIC KEY-----\nSHIM\n-----END PUBLIC KEY-----\n",
    },
  };
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/activity+json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** Extract the trailing /diffs/<id> segment of an activity id, or null. */
function diffIdOf(activity) {
  const id = typeof activity?.id === "string" ? activity.id : "";
  const m = id.match(/\/diffs\/([^/]+)$/);
  return m ? m[1] : null;
}

/** Reflect a received activity into the group outbox (idempotent by activity id). */
function reflect(nid, activity) {
  const g = groupFor(nid);
  const id = (typeof activity?.id === "string" && activity.id) || `__anon-${g.order.length}`;
  if (g.activityById.has(id)) return; // dedup — a re-delivered activity is a no-op
  g.activityById.set(id, activity);
  g.order.push(id);
  const diffId = diffIdOf(activity);
  if (diffId) g.byDiffId.set(diffId, activity);
}

/** One-line request log (enabled with AP_SHIM_LOG=1) so a C1 run can be traced. */
const LOG = process.env.AP_SHIM_LOG === "1";
function trace(req, extra) {
  if (LOG) console.log(`[ap-group-shim] ${req.method} ${req.url}${extra ? " " + extra : ""}`);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;

  if (path === "/" || path === "/health") {
    trace(req, `groups=${groups.size}`);
    return sendJson(res, 200, { ok: true, groups: groups.size });
  }

  // Debug: per-group outbox sizes, so a run can be inspected without the nid.
  if (path === "/debug/groups") {
    const summary = {};
    for (const [nid, g] of groups.entries()) {
      summary[nid] = { outbox: g.order.length, diffs: g.byDiffId.size };
    }
    return sendJson(res, 200, summary);
  }

  const prefix = "/ap/v1/groups/";
  if (!path.startsWith(prefix)) {
    return sendJson(res, 404, { error: "not found" });
  }

  const segments = path.slice(prefix.length).split("/").filter((s) => s.length > 0);
  const nid = segments[0];
  const sub = segments[1]; // inbox | outbox | followers | diffs | undefined
  const diffId = segments[2]; // present when sub === "diffs"

  if (!nid) return sendJson(res, 404, { error: "no group id" });

  // POST inbox → reflect the activity into the outbox for all members to pull.
  if (sub === "inbox" && req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let activity;
      try {
        activity = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return sendJson(res, 400, { error: "bad json" });
      }
      // A real group would run the Follow/Accept handshake; here membership is
      // open, so Follow/Undo are acknowledged but not reflected as content.
      if (activity && activity.type !== "Follow" && activity.type !== "Undo") {
        reflect(nid, activity);
        trace(req, `nid=${nid} reflect type=${activity.type} id=${activity.id} outbox=${groupFor(nid).order.length}`);
      } else {
        trace(req, `nid=${nid} skip type=${activity?.type}`);
      }
      return sendJson(res, 202, { ok: true });
    });
    return;
  }

  if (req.method !== "GET") {
    return sendJson(res, 405, { error: "method not allowed" });
  }

  if (sub === "outbox") {
    const g = groupFor(nid);
    const items = g.order.map((id) => g.activityById.get(id)).filter(Boolean);
    trace(req, `nid=${nid} outbox serve ${items.length} items`);
    return sendJson(res, 200, {
      "@context": "https://www.w3.org/ns/activitystreams",
      type: "OrderedCollection",
      id: `${actorUrl(nid)}/outbox`,
      totalItems: items.length,
      orderedItems: items,
    });
  }

  if (sub === "followers") {
    return sendJson(res, 200, {
      "@context": "https://www.w3.org/ns/activitystreams",
      type: "OrderedCollection",
      id: `${actorUrl(nid)}/followers`,
      totalItems: 0,
      orderedItems: [],
    });
  }

  if (sub === "diffs" && diffId) {
    const activity = groupFor(nid).byDiffId.get(diffId);
    trace(req, `nid=${nid} diff ${diffId} ${activity ? "hit" : "MISS"}`);
    if (!activity) return sendJson(res, 404, { error: "unknown diff" });
    return sendJson(res, 200, activity);
  }

  if (!sub) {
    return sendJson(res, 200, actorDoc(nid));
  }

  return sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`[ap-group-shim] listening on http://${HOST}:${PORT} (AP_SHIM_PORT to override)`);
});
