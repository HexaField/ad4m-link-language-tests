#!/usr/bin/env node
/**
 * Deterministic mock LLM for the agent-harness wind tunnel.
 *
 * Speaks OpenAI chat-completions and Anthropic Messages so OpenClaw, Hermes, and
 * Sovereign can all point their model provider here. It returns a scripted
 * sequence of tool calls (or a final text), which makes every non-model failure
 * reproducible — we prove the plumbing before a real model ever runs.
 *
 * Config via env:
 *   PORT             — listen port (default 8080)
 *   MOCK_LLM_LOG=1   — log each incoming request to stderr (learn a harness's contract)
 *   MOCK_LLM_SCRIPT  — JSON array of steps; each step is {tool_calls:[{name,arguments}]} or {text:"..."}
 *
 * The script advances one step per chat/messages request; when it runs out it
 * returns a final "done" text. A fresh instance per scenario keeps it deterministic.
 */
import http from "node:http";

const PORT = Number(process.env.PORT || 8080);
const LOG = process.env.MOCK_LLM_LOG === "1";

let script = [];
try {
  if (process.env.MOCK_LLM_SCRIPT) script = JSON.parse(process.env.MOCK_LLM_SCRIPT);
} catch (e) {
  console.error("[mock-llm] bad MOCK_LLM_SCRIPT:", e.message);
}
let step = 0;

function nextStep() {
  const s = step < script.length ? script[step] : { text: "done" };
  step += 1;
  return s;
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url || "";

  if (req.method === "GET" && (url === "/health" || url === "/")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", step, scriptLen: script.length }));
  }
  if (req.method === "GET" && url.startsWith("/v1/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(
      JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model", owned_by: "windtunnel" }] }),
    );
  }

  const body = await readBody(req);
  if (LOG) console.error(`\n=== ${req.method} ${url} ===\n${body.slice(0, 6000)}`);
  const s = nextStep();

  // OpenAI chat-completions
  if (url.includes("/chat/completions")) {
    let message;
    if (s.tool_calls) {
      message = {
        role: "assistant",
        content: null,
        tool_calls: s.tool_calls.map((t, i) => ({
          id: `call_${step}_${i}`,
          type: "function",
          function: { name: t.name, arguments: JSON.stringify(t.arguments || {}) },
        })),
      };
    } else {
      message = { role: "assistant", content: s.text || "done" };
    }
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(
      JSON.stringify({
        id: `chatcmpl-mock-${step}`,
        object: "chat.completion",
        created: 0,
        model: "mock-model",
        choices: [{ index: 0, message, finish_reason: s.tool_calls ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
    );
  }

  // Anthropic Messages
  if (url.includes("/messages")) {
    let content;
    let stop_reason;
    if (s.tool_calls) {
      content = s.tool_calls.map((t, i) => ({
        type: "tool_use",
        id: `toolu_${step}_${i}`,
        name: t.name,
        input: t.arguments || {},
      }));
      stop_reason = "tool_use";
    } else {
      content = [{ type: "text", text: s.text || "done" }];
      stop_reason = "end_turn";
    }
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(
      JSON.stringify({
        id: `msg_mock_${step}`,
        type: "message",
        role: "assistant",
        model: "mock-model",
        content,
        stop_reason,
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    );
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found", url }));
});

server.listen(PORT, () => console.error(`[mock-llm] listening on :${PORT} (script steps: ${script.length}, LOG=${LOG})`));
