/**
 * A4 (Sovereign) ad4m helper — the node-side operations for the Sovereign
 * native-waker test, over MCP with a user JWT.
 *
 *   mint      <base> <jwt> <name>                  -> prints UUID=<uuid>
 *   mention   <base> <jwt> <uuid> <chan> <msg> <b> -> inject a mention message
 *                                                     (has_child + message_body)
 *   child-has <base> <jwt> <uuid> <chan> <marker>  -> prints REPLY=found|missing
 *                                                     (a channel child whose body
 *                                                      contains <marker>)
 */
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { existsSync } from "fs";

let HARNESS = dirname(fileURLToPath(import.meta.url));
while (HARNESS !== "/" && !existsSync(resolve(HARNESS, "src/mcp-client.ts"))) {
  HARNESS = resolve(HARNESS, "..");
}

(async () => {
  const { McpClient } = await import(`${HARNESS}/src/mcp-client.ts`);
  const [, , action, base, token, ...rest] = process.argv;
  const c = new McpClient(base, token);
  await c.initialize("a4sv");

  if (action === "mint") {
    const p = await c.callToolJson("add_perspective", { name: rest[0] });
    console.log("UUID=" + (p.uuid || ""));
  } else if (action === "mention") {
    const [uuid, chan, msg, body] = rest;
    // The waker's mention query decodes the target via ad4m://fn/parse_literal,
    // so the body must be an AD4M literal (literal://string:<urlencoded>).
    const literal = `literal://string:${encodeURIComponent(body)}`;
    await c.callToolJson("add_link", { perspective_id: uuid, source: chan, predicate: "ad4m://has_child", target: msg });
    await c.callToolJson("add_link", { perspective_id: uuid, source: msg, predicate: "ad4m://message_body", target: literal });
    console.log("INJECTED");
  } else if (action === "child-has") {
    const [uuid, chan, marker] = rest;
    const kids = await c.callToolJson("query_links", { perspective_id: uuid, source: chan });
    const childTargets = [...new Set([...JSON.stringify(kids).matchAll(/"target":"([^"]+)"/g)].map((m) => m[1]))];
    let found = false;
    for (const ct of childTargets) {
      const cl = await c.callToolJson("query_links", { perspective_id: uuid, source: ct });
      if (JSON.stringify(cl).includes(marker)) {
        found = true;
        break;
      }
    }
    console.log("REPLY=" + (found ? "found" : "missing"));
  } else {
    console.error("usage: waker-ad4m.ts mint|mention|child-has ...");
    process.exit(2);
  }
})().catch((e) => {
  console.error("[a4sv] FATAL", e?.stack || e);
  process.exit(2);
});
