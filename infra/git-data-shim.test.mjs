/**
 * Regression tests for git-data-shim.mjs.
 *
 * The load-bearing invariant is SHA parity: git-link-language's push path
 * asserts `returnedSha === localOid` for every blob, tree, and commit it POSTs
 * (remote-sync.ts `assertSha`). If the shim canonicalises any object even one
 * byte differently, a real push throws and convergence fails. These tests
 * compute the OIDs locally exactly the way the language does (writeBlob ->
 * nested links/ tree -> UTC-pinned commit) and assert the shim reproduces each
 * one over its HTTP surface, then cover ref fast-forward / create-conflict.
 *
 * Run: node --test infra/git-data-shim.test.mjs
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as git from "isomorphic-git";
import { startShim } from "./git-data-shim.mjs";

let shim;
let base;
let tmpRoot;

before(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "git-shim-test-"));
    shim = await startShim({
        port: 0,
        host: "127.0.0.1",
        root: path.join(tmpRoot, "store"),
    });
    base = `http://127.0.0.1:${shim.port}`;
});

after(async () => {
    await new Promise((r) => shim.server.close(r));
    await fsp.rm(tmpRoot, { recursive: true, force: true });
});

const IDENTITY = {
    name: "did:key:zTestAgent",
    email: "did:key:zTestAgent@ad4m",
    timezoneOffset: 0,
};

/**
 * Compute the OIDs the language would compute locally for a one-link commit:
 * a blob, a `links/<hash>.json` nested tree, and a UTC-pinned commit.
 */
async function localObjects({ content, hash, message, timestamp, parents = [] }) {
    const dir = await fsp.mkdtemp(path.join(tmpRoot, "local-"));
    await git.init({ fs, dir, defaultBranch: "main" });
    const blobOid = await git.writeBlob({
        fs,
        dir,
        blob: new TextEncoder().encode(content),
    });
    const linksTree = await git.writeTree({
        fs,
        dir,
        tree: [{ mode: "100644", path: `${hash}.json`, oid: blobOid, type: "blob" }],
    });
    const rootTree = await git.writeTree({
        fs,
        dir,
        tree: [{ mode: "040000", path: "links", oid: linksTree, type: "tree" }],
    });
    const author = { ...IDENTITY, timestamp };
    const commitOid = await git.writeCommit({
        fs,
        dir,
        commit: { message, tree: rootTree, parent: parents, author, committer: author },
    });
    return { blobOid, linksTree, rootTree, commitOid };
}

function api(repo, path_, init) {
    return fetch(`${base}/repos/c1/${repo}${path_}`, init);
}
function postJson(repo, path_, body) {
    return api(repo, path_, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}
function patchJson(repo, path_, body) {
    return api(repo, path_, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}
const isoDate = (ts) => new Date(ts * 1000).toISOString();

// ---------------------------------------------------------------------------

test("blob / tree / commit POSTs reproduce local OIDs (SHA parity)", async () => {
    const repo = "parity";
    const content = JSON.stringify({
        author: "did:key:zTestAgent",
        data: { source: "did:a", predicate: "sioc:knows", target: "did:b" },
        timestamp: "2026-07-13T00:00:00.000Z",
    });
    const hash = "a1b2c3d4e5f6";
    const timestamp = 1_700_000_000;
    const local = await localObjects({
        content,
        hash,
        message: "diff: +1 -0",
        timestamp,
    });

    const blob = await postJson(repo, "/git/blobs", {
        content,
        encoding: "utf-8",
    });
    assert.equal(blob.status, 201);
    assert.equal((await blob.json()).sha, local.blobOid, "blob OID parity");

    const tree = await postJson(repo, "/git/trees", {
        tree: [
            {
                path: `links/${hash}.json`,
                mode: "100644",
                type: "blob",
                sha: local.blobOid,
            },
        ],
    });
    assert.equal(tree.status, 201);
    assert.equal((await tree.json()).sha, local.rootTree, "tree OID parity");

    const commit = await postJson(repo, "/git/commits", {
        message: "diff: +1 -0",
        tree: local.rootTree,
        parents: [],
        author: { ...IDENTITY, date: isoDate(timestamp) },
        committer: { ...IDENTITY, date: isoDate(timestamp) },
    });
    assert.equal(commit.status, 201);
    assert.equal((await commit.json()).sha, local.commitOid, "commit OID parity");

    // Real-flow guard: the push path posts the message it READ BACK from the
    // local object, which isomorphic-git canonicalises with a trailing newline
    // ("diff: +1 -0\n"). writeCommit is idempotent over that newline, so the
    // re-posted commit must still reproduce the same OID (never a double "\n").
    const reposted = await postJson(repo, "/git/commits", {
        message: "diff: +1 -0\n",
        tree: local.rootTree,
        parents: [],
        author: { ...IDENTITY, date: isoDate(timestamp) },
        committer: { ...IDENTITY, date: isoDate(timestamp) },
    });
    assert.equal(
        (await reposted.json()).sha,
        local.commitOid,
        "commit OID parity is stable under the read-back trailing newline",
    );
});

test("reads round-trip commit, tree, and blob", async () => {
    const repo = "reads";
    const content = JSON.stringify({ hello: "world", n: 42 });
    const hash = "deadbeef00";
    const timestamp = 1_700_000_500;
    const local = await localObjects({
        content,
        hash,
        message: "diff: +1 -0",
        timestamp,
    });
    await postJson(repo, "/git/blobs", { content, encoding: "utf-8" });
    await postJson(repo, "/git/trees", {
        tree: [
            { path: `links/${hash}.json`, mode: "100644", type: "blob", sha: local.blobOid },
        ],
    });
    await postJson(repo, "/git/commits", {
        message: "diff: +1 -0",
        tree: local.rootTree,
        parents: [],
        author: { ...IDENTITY, date: isoDate(timestamp) },
        committer: { ...IDENTITY, date: isoDate(timestamp) },
    });

    const commit = await (await api(repo, `/git/commits/${local.commitOid}`)).json();
    assert.equal(commit.sha, local.commitOid);
    assert.equal(commit.tree.sha, local.rootTree);
    // isomorphic-git canonicalises the commit message with a trailing newline.
    assert.equal(commit.message, "diff: +1 -0\n");
    assert.deepEqual(commit.parents, []);
    // The date round-trips back to the same UTC second.
    assert.equal(Math.floor(Date.parse(commit.author.date) / 1000), timestamp);

    const treeResp = await (
        await api(repo, `/git/trees/${local.rootTree}?recursive=1`)
    ).json();
    const blobEntry = treeResp.tree.find((e) => e.path === `links/${hash}.json`);
    assert.ok(blobEntry, "recursive tree lists the link blob at its full path");
    assert.equal(blobEntry.type, "blob");
    assert.equal(blobEntry.sha, local.blobOid);

    const blobResp = await (await api(repo, `/git/blobs/${local.blobOid}`)).json();
    assert.equal(blobResp.sha, local.blobOid);
    assert.equal(Buffer.from(blobResp.content, "base64").toString("utf8"), content);
});

test("ref lifecycle: create, get, conditional 304, fast-forward, non-ff 422", async () => {
    const repo = "refs";
    const ts = 1_700_001_000;
    // Root commit c1.
    const c1 = await localObjects({
        content: "L1",
        hash: "h1",
        message: "diff: +1 -0",
        timestamp: ts,
    });
    // Descendant c3 (parent c1) and a divergent root c2.
    const c3 = await localObjects({
        content: "L1L2",
        hash: "h3",
        message: "diff: +1 -0",
        timestamp: ts + 2,
        parents: [c1.commitOid],
    });
    const c2 = await localObjects({
        content: "X",
        hash: "h2",
        message: "diff: +1 -0",
        timestamp: ts + 1,
    });

    // Persist all three commits in the shim's store (parents needed for
    // isDescendent to resolve). Each must be posted with the SAME timestamp and
    // parents used to compute its OID, or the shim would store a different OID.
    const posted = [
        { c: c1, timestamp: ts, parents: [] },
        { c: c3, timestamp: ts + 2, parents: [c1.commitOid] },
        { c: c2, timestamp: ts + 1, parents: [] },
    ];
    for (const { c, timestamp, parents } of posted) {
        const r = await postJson(repo, "/git/commits", {
            message: "diff: +1 -0",
            tree: c.rootTree,
            parents,
            author: { ...IDENTITY, date: isoDate(timestamp) },
            committer: { ...IDENTITY, date: isoDate(timestamp) },
        });
        assert.equal(r.status, 201);
        assert.equal((await r.json()).sha, c.commitOid, "posted commit OID parity");
    }

    // GET before create -> 404.
    assert.equal((await api(repo, "/git/refs/heads/main")).status, 404);

    // Create the ref.
    const create = await postJson(repo, "/git/refs", {
        ref: "refs/heads/main",
        sha: c1.commitOid,
    });
    assert.equal(create.status, 201);

    // Re-create -> 422.
    const dup = await postJson(repo, "/git/refs", {
        ref: "refs/heads/main",
        sha: c1.commitOid,
    });
    assert.equal(dup.status, 422);

    // GET -> the created sha, with an ETag; conditional re-GET -> 304.
    const got = await api(repo, "/git/refs/heads/main");
    assert.equal(got.status, 200);
    assert.equal((await got.json()).object.sha, c1.commitOid);
    const etag = got.headers.get("etag");
    assert.ok(etag, "ref GET returns an ETag");
    const cond = await api(repo, "/git/refs/heads/main", {
        headers: { "If-None-Match": etag },
    });
    assert.equal(cond.status, 304);

    // Non-fast-forward (c2 is a divergent root) -> 422.
    const nonFf = await patchJson(repo, "/git/refs/heads/main", {
        sha: c2.commitOid,
        force: false,
    });
    assert.equal(nonFf.status, 422);

    // Fast-forward (c3 descends from c1) -> 200, ref advances.
    const ff = await patchJson(repo, "/git/refs/heads/main", {
        sha: c3.commitOid,
        force: false,
    });
    assert.equal(ff.status, 200);
    const after = await (await api(repo, "/git/refs/heads/main")).json();
    assert.equal(after.object.sha, c3.commitOid);

    // No-op update to the current value -> 200.
    const noop = await patchJson(repo, "/git/refs/heads/main", {
        sha: c3.commitOid,
        force: false,
    });
    assert.equal(noop.status, 200);
});

test("missing objects return 404", async () => {
    const repo = "missing";
    const bogus = "0".repeat(40);
    assert.equal((await api(repo, `/git/commits/${bogus}`)).status, 404);
    assert.equal((await api(repo, `/git/trees/${bogus}`)).status, 404);
    assert.equal((await api(repo, `/git/blobs/${bogus}`)).status, 404);
});
