/**
 * git-data-shim — a dependency-light GitHub-git-data-API server for C1.
 *
 * git-link-language talks GitHub's JSON git-data plumbing (refs / commits /
 * trees / blobs) rather than the native smart protocol, because the executor's
 * httpFetch UTF-8-decodes response bodies and would corrupt binary pack files.
 * This shim implements exactly that REST surface against a real local Git
 * object store, so two co-located executors can converge over it without any
 * github.com dependency (the language points at it via GIT_API_BASE).
 *
 * ## Why isomorphic-git backs it
 *
 * The push path asserts `returnedSha === localOid` for every blob, tree, and
 * commit it POSTs (remote-sync.ts `assertSha`): the remote MUST reproduce the
 * exact object IDs the language computed locally, or the push throws. The
 * language computes those OIDs with isomorphic-git; backing the shim with the
 * same library makes SHA parity hold by construction — the identical canonical
 * git encoding runs on both sides. (Git object hashing is implementation-
 * independent, so the shim's isomorphic-git version need not match the
 * language's.)
 *
 * ## Endpoints (all under /repos/:owner/:repo)
 *
 *   GET   /git/refs/heads/:branch      -> { ref, object:{ sha } } + ETag; 304; 404
 *   GET   /git/commits/:sha            -> { sha, tree:{sha}, parents:[{sha}], ... }
 *   GET   /git/trees/:sha?recursive=1  -> { sha, truncated, tree:[...] }
 *   GET   /git/blobs/:sha              -> { sha, content(base64), encoding, size }
 *   POST  /git/blobs                   -> { sha }
 *   POST  /git/trees                   -> { sha }   (full-path entries -> nested trees)
 *   POST  /git/commits                 -> { sha }
 *   POST  /git/refs                    -> { ref, object:{sha} }   (create; 422 if exists)
 *   PATCH /git/refs/heads/:branch      -> { ref, object:{sha} }   (200 ff; 422 non-ff; 404)
 *
 * ## State
 *
 * One real Git repo per owner/repo under GIT_SHIM_ROOT (default a fresh temp
 * dir). C1 uses a fresh neighbourhood id per run, so each run addresses a fresh
 * repo. A per-repo async mutex serialises all operations on a repo so the two
 * agents' concurrent pushes/pulls never interleave a ref read/update.
 *
 * Env: GIT_DATA_SHIM_PORT (default 7792), GIT_DATA_SHIM_HOST (127.0.0.1),
 *      GIT_SHIM_ROOT (default os.tmpdir()/git-data-shim-<pid>),
 *      GIT_SHIM_TRACE (set to enable per-request logging).
 */

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as git from "isomorphic-git";

const TRACE = Boolean(process.env.GIT_SHIM_TRACE);

// Object-store root — set by startShim(); one subdir per owner/repo.
let ROOT = path.join(os.tmpdir(), `git-data-shim-${process.pid}`);

function trace(...args) {
    if (TRACE) console.log("[git-data-shim]", ...args);
}

// ---------------------------------------------------------------------------
// Per-repo async mutex — serialise all ops on one repo so concurrent agent
// pushes never interleave a ref read/update.
// ---------------------------------------------------------------------------

const locks = new Map();

async function withLock(key, fn) {
    const prev = locks.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((res) => {
        release = res;
    });
    const mine = prev.then(() => gate);
    locks.set(key, mine);
    await prev;
    try {
        return await fn();
    } finally {
        release();
        // If no one queued behind us, drop the entry so the map stays bounded
        // by concurrently-active repos rather than total repos ever seen.
        if (locks.get(key) === mine) locks.delete(key);
    }
}

// ---------------------------------------------------------------------------
// Repo management
// ---------------------------------------------------------------------------

/** Sanitise an owner/repo pair into a single on-disk directory name. */
function repoKey(owner, repo) {
    const safe = (s) => s.replace(/[^A-Za-z0-9._-]/g, "_");
    return `${safe(owner)}__${safe(repo)}`;
}

/** Ensure a real git repo exists for owner/repo and return its dir. */
async function ensureRepo(owner, repo) {
    const dir = path.join(ROOT, repoKey(owner, repo));
    let inited = false;
    try {
        await fsp.stat(path.join(dir, ".git", "HEAD"));
        inited = true;
    } catch (_e) {
        inited = false;
    }
    if (!inited) {
        await fsp.mkdir(dir, { recursive: true });
        await git.init({ fs, dir, defaultBranch: "main" });
    }
    return dir;
}

// ---------------------------------------------------------------------------
// Object helpers
// ---------------------------------------------------------------------------

/**
 * Write a tree from GitHub-style flat entries (paths may contain slashes),
 * reconstructing the nested subtree structure and returning the root OID.
 * `links/<hash>.json` entries therefore produce a `links` subtree whose OID
 * matches the language's local `writeRootTreeFromLinkBlobs` output.
 */
async function writeNestedTree(dir, entries) {
    const leaves = [];
    const subdirs = new Map();
    for (const e of entries) {
        const slash = e.path.indexOf("/");
        if (slash === -1) {
            leaves.push({
                mode: e.mode || (e.type === "tree" ? "040000" : "100644"),
                path: e.path,
                oid: e.sha,
                type: e.type || "blob",
            });
        } else {
            const top = e.path.slice(0, slash);
            const rest = e.path.slice(slash + 1);
            if (!subdirs.has(top)) subdirs.set(top, []);
            subdirs.get(top).push({ ...e, path: rest });
        }
    }
    const tree = [...leaves];
    for (const [name, subEntries] of subdirs) {
        const subOid = await writeNestedTree(dir, subEntries);
        tree.push({ mode: "040000", path: name, oid: subOid, type: "tree" });
    }
    return await git.writeTree({ fs, dir, tree });
}

/** Flatten a tree recursively into GitHub-style full-path entries. */
async function readTreeRecursive(dir, oid, prefix, out) {
    const { tree } = await git.readTree({ fs, dir, oid });
    for (const e of tree) {
        const full = prefix ? `${prefix}/${e.path}` : e.path;
        if (e.type === "tree") {
            out.push({ path: full, mode: e.mode, type: "tree", sha: e.oid });
            await readTreeRecursive(dir, e.oid, full, out);
        } else {
            let size;
            try {
                const { blob } = await git.readBlob({ fs, dir, oid: e.oid });
                size = blob.length;
            } catch (_e) {
                size = undefined;
            }
            out.push({
                path: full,
                mode: e.mode,
                type: e.type === "blob" ? "blob" : e.type,
                sha: e.oid,
                size,
            });
        }
    }
}

/** Parse a GitHub signature { name, email, date } into an isomorphic-git author.
 *  Dates are UTC ISO ('...Z'); the language pins local commits to timezoneOffset
 *  0, so 0 here reproduces the exact `<ts> +0000` line git hashed. */
function parseSig(sig) {
    const ms = Date.parse(sig?.date ?? "");
    const timestamp = Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
    return {
        name: sig?.name ?? "",
        email: sig?.email ?? "",
        timestamp,
        timezoneOffset: 0,
    };
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function sendJson(res, status, obj, extraHeaders) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        ...(extraHeaders || {}),
    });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

function notFound(res, message = "Not Found") {
    sendJson(res, 404, { message });
}

const NOT_FOUND_RE = /Could not find|NotFoundError|does not exist|ENOENT/i;

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleGetRef(res, dir, branch) {
    const ref = `refs/heads/${branch}`;
    let sha;
    try {
        sha = await git.resolveRef({ fs, dir, ref });
    } catch (_e) {
        return notFound(res, `branch ${branch} not found`);
    }
    return { sha, ref };
}

async function handleGetCommit(res, dir, sha) {
    let commit;
    try {
        ({ commit } = await git.readCommit({ fs, dir, oid: sha }));
    } catch (e) {
        if (NOT_FOUND_RE.test(e.message)) return notFound(res, `commit ${sha}`);
        throw e;
    }
    sendJson(res, 200, {
        sha,
        tree: { sha: commit.tree },
        parents: commit.parent.map((p) => ({ sha: p })),
        message: commit.message,
        author: {
            name: commit.author.name,
            email: commit.author.email,
            date: new Date(commit.author.timestamp * 1000).toISOString(),
        },
        committer: {
            name: commit.committer.name,
            email: commit.committer.email,
            date: new Date(commit.committer.timestamp * 1000).toISOString(),
        },
    });
}

async function handleGetTree(res, dir, sha) {
    const out = [];
    try {
        await readTreeRecursive(dir, sha, "", out);
    } catch (e) {
        if (NOT_FOUND_RE.test(e.message)) return notFound(res, `tree ${sha}`);
        throw e;
    }
    sendJson(res, 200, { sha, truncated: false, tree: out });
}

async function handleGetBlob(res, dir, sha) {
    let blob;
    try {
        ({ blob } = await git.readBlob({ fs, dir, oid: sha }));
    } catch (e) {
        if (NOT_FOUND_RE.test(e.message)) return notFound(res, `blob ${sha}`);
        throw e;
    }
    const buf = Buffer.from(blob);
    sendJson(res, 200, {
        sha,
        content: buf.toString("base64"),
        encoding: "base64",
        size: buf.length,
    });
}

async function handlePostBlob(res, dir, body) {
    const { content, encoding } = JSON.parse(body || "{}");
    const bytes =
        encoding === "base64"
            ? Buffer.from(content ?? "", "base64")
            : Buffer.from(content ?? "", "utf8");
    const oid = await git.writeBlob({ fs, dir, blob: new Uint8Array(bytes) });
    sendJson(res, 201, { sha: oid });
}

async function handlePostTree(res, dir, body) {
    const { tree } = JSON.parse(body || "{}");
    if (!Array.isArray(tree)) {
        return sendJson(res, 422, { message: "tree must be an array" });
    }
    const oid = await writeNestedTree(dir, tree);
    sendJson(res, 201, { sha: oid });
}

async function handlePostCommit(res, dir, body) {
    const input = JSON.parse(body || "{}");
    const oid = await git.writeCommit({
        fs,
        dir,
        commit: {
            message: input.message ?? "",
            tree: input.tree,
            parent: Array.isArray(input.parents) ? input.parents : [],
            author: parseSig(input.author),
            committer: parseSig(input.committer ?? input.author),
        },
    });
    sendJson(res, 201, { sha: oid });
}

async function handlePostRef(res, dir, body) {
    const { ref, sha } = JSON.parse(body || "{}");
    if (!ref || !sha) {
        return sendJson(res, 422, { message: "ref and sha are required" });
    }
    // Create only — 422 if the ref already exists (matches GitHub).
    try {
        await git.resolveRef({ fs, dir, ref });
        return sendJson(res, 422, { message: "Reference already exists" });
    } catch (_e) {
        // Does not exist yet — create it.
    }
    await git.writeRef({ fs, dir, ref, value: sha, force: false });
    sendJson(res, 201, { ref, object: { sha, type: "commit" } });
}

async function handlePatchRef(res, dir, branch, body) {
    const { sha, force } = JSON.parse(body || "{}");
    const ref = `refs/heads/${branch}`;
    let current;
    try {
        current = await git.resolveRef({ fs, dir, ref });
    } catch (_e) {
        // Missing ref -> 404 so the language falls through to createRef.
        return notFound(res, `branch ${branch} not found`);
    }
    if (sha === current) {
        // No-op update to the current value is a success, not a conflict.
        return sendJson(res, 200, { ref, object: { sha, type: "commit" } });
    }
    let fastForward = Boolean(force);
    if (!fastForward) {
        try {
            fastForward = await git.isDescendent({
                fs,
                dir,
                oid: sha,
                ancestor: current,
                depth: -1,
            });
        } catch (_e) {
            fastForward = false;
        }
    }
    if (!fastForward) {
        return sendJson(res, 422, {
            message: "Update is not a fast forward",
        });
    }
    await git.writeRef({ fs, dir, ref, value: sha, force: true });
    sendJson(res, 200, { ref, object: { sha, type: "commit" } });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function requestHandler(req, res) {
    const method = req.method || "GET";
    let url;
    try {
        url = new URL(req.url, "http://shim.local");
    } catch (_e) {
        return sendJson(res, 400, { message: "bad url" });
    }
    const parts = url.pathname.split("/").filter((s) => s.length > 0);
    trace(method, url.pathname);

    // Friendly root for humans; the C1 health probe only needs a TCP listener.
    if (parts.length === 0) {
        return sendJson(res, 200, { service: "git-data-shim", root: ROOT });
    }

    // All API routes: /repos/:owner/:repo/git/:resource/...
    if (parts[0] !== "repos" || parts.length < 5 || parts[3] !== "git") {
        return notFound(res, "no such route");
    }
    const owner = decodeURIComponent(parts[1]);
    const repo = decodeURIComponent(parts[2]);
    const resource = parts[4];
    const rest = parts.slice(5).map((s) => decodeURIComponent(s));
    const key = repoKey(owner, repo);

    try {
        const body =
            method === "POST" || method === "PATCH"
                ? await readBody(req)
                : "";
        await withLock(key, async () => {
            const dir = await ensureRepo(owner, repo);

            if (resource === "refs") {
                // GET/PATCH /git/refs/heads/:branch ; POST /git/refs
                if (method === "POST") return handlePostRef(res, dir, body);
                if (rest[0] === "heads" && rest.length >= 2) {
                    const branch = rest.slice(1).join("/");
                    if (method === "GET") {
                        const r = await handleGetRef(res, dir, branch);
                        if (!r) return; // 404 already sent
                        const etag = `"${r.sha}"`;
                        const inm = req.headers["if-none-match"];
                        if (inm && inm === etag) {
                            res.writeHead(304, { ETag: etag });
                            return res.end();
                        }
                        return sendJson(
                            res,
                            200,
                            {
                                ref: r.ref,
                                object: { sha: r.sha, type: "commit" },
                            },
                            { ETag: etag },
                        );
                    }
                    if (method === "PATCH") {
                        return handlePatchRef(res, dir, branch, body);
                    }
                }
                return notFound(res, "bad refs route");
            }

            if (resource === "commits") {
                if (method === "POST") return handlePostCommit(res, dir, body);
                if (method === "GET" && rest[0]) {
                    return handleGetCommit(res, dir, rest[0]);
                }
                return notFound(res, "bad commits route");
            }

            if (resource === "trees") {
                if (method === "POST") return handlePostTree(res, dir, body);
                if (method === "GET" && rest[0]) {
                    return handleGetTree(res, dir, rest[0]);
                }
                return notFound(res, "bad trees route");
            }

            if (resource === "blobs") {
                if (method === "POST") return handlePostBlob(res, dir, body);
                if (method === "GET" && rest[0]) {
                    return handleGetBlob(res, dir, rest[0]);
                }
                return notFound(res, "bad blobs route");
            }

            return notFound(res, `unknown resource ${resource}`);
        });
    } catch (e) {
        trace("ERROR", method, url.pathname, e.message);
        sendJson(res, 500, { message: e.message });
    }
}

/**
 * Start the shim. Returns { server, port, root }. `port: 0` binds an
 * ephemeral port (used by the test harness); the real address is read back
 * from server.address().
 */
export function startShim({ port, host = "127.0.0.1", root } = {}) {
    if (root) ROOT = root;
    const server = http.createServer(requestHandler);
    return new Promise((resolve, reject) => {
        fsp.mkdir(ROOT, { recursive: true })
            .then(() => {
                server.once("error", reject);
                server.listen(port, host, () => {
                    const actual = server.address().port;
                    console.log(
                        `[git-data-shim] listening on http://${host}:${actual} (root ${ROOT})`,
                    );
                    resolve({ server, port: actual, host, root: ROOT });
                });
            })
            .catch(reject);
    });
}

// Auto-start when run directly (not when imported by a test).
const invokedDirectly =
    process.argv[1] &&
    import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
    await startShim({
        port: parseInt(process.env.GIT_DATA_SHIM_PORT || "7792", 10),
        host: process.env.GIT_DATA_SHIM_HOST || "127.0.0.1",
        root: process.env.GIT_SHIM_ROOT,
    });
}
