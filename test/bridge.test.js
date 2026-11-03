import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBridge, parseSse, resolveConfig } from "../src/bridge.js";

const BIN = fileURLToPath(new URL("../bin/plcgateway-mcp.js", import.meta.url));
const TOKEN = "test-token";

// A stand-in for PLCGateway's /mcp: JSON reply per request, 202 for notifications.
let server, base;
const seen = [];
before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url === "/disabled/mcp") return res.writeHead(404).end('{"error":"MCP disabled"}');
      if (req.url !== "/mcp") return res.writeHead(404).end();
      if (req.method === "DELETE") return res.writeHead(200).end();
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end('{"error":"unauthorized"}');
      const msg = JSON.parse(body);
      if (msg.id === undefined) return res.writeHead(202).end();
      let result;
      if (msg.method === "initialize") result = { protocolVersion: "2025-06-18", serverInfo: { name: "plcgateway", version: "x" }, capabilities: { tools: {} } };
      else if (msg.method === "tools/list") result = { tools: [{ name: "active_alarms", inputSchema: { type: "object" } }] };
      else if (msg.method === "tools/call" && msg.params?.name === "slow") return setTimeout(() => res.writeHead(200).end("{}"), 3000);
      else if (msg.method === "tools/call" && msg.params?.name === "sse") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "via sse" }] } })}\n\n`);
      } else result = { content: [{ type: "text", text: `called ${msg.params?.name}` }] };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test("config: adds /mcp, accepts host:port, reports what is missing", () => {
  assert.equal(resolveConfig({ PLCGATEWAY_URL: "http://10.0.0.5:8080", PLCGATEWAY_TOKEN: "t" }, []).endpoint, "http://10.0.0.5:8080/mcp");
  assert.equal(resolveConfig({ PLCGATEWAY_URL: "10.0.0.5:8080/", PLCGATEWAY_TOKEN: "t" }, []).endpoint, "http://10.0.0.5:8080/mcp");
  assert.equal(resolveConfig({ PLCGATEWAY_URL: "https://plant.local/mcp/", PLCGATEWAY_TOKEN: "t" }, []).endpoint, "https://plant.local/mcp");
  assert.equal(resolveConfig({}, ["--url", "http://h:1", "--token", "x"]).endpoint, "http://h:1/mcp");
  const bad = resolveConfig({}, []);
  assert.equal(bad.problems.length, 2);
  assert.match(bad.problems.join(" "), /PLCGATEWAY_URL.*PLCGATEWAY_TOKEN/s);
});

test("parseSse reads data fields", () => {
  assert.deepEqual(parseSse('event: message\ndata: {"a":1}\n\ndata: {"b":\ndata: 2}\n\n'), [{ a: 1 }, { b: 2 }]);
});

test("bridge: forwards, passes notifications, maps HTTP errors to JSON-RPC errors", async () => {
  const out = [];
  const b = createBridge({ endpoint: `${base}/mcp`, token: TOKEN, timeoutMs: 1000, write: (m) => out.push(m) });
  await b.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }));
  await b.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  await b.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "sse" } }));
  await b.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "slow" } }));
  await b.handleLine("not json");
  assert.equal(out[0].result.serverInfo.name, "plcgateway");
  assert.equal(out[1].result.content[0].text, "via sse");
  assert.equal(out[2].id, 3);
  assert.match(out[2].error.message, /timed out/);
  assert.equal(out[3].error.code, -32700);
  const last = seen.filter((s) => s.method === "POST").at(-1);
  assert.equal(last.headers["mcp-protocol-version"], "2025-06-18");
  assert.equal(last.headers.authorization, `Bearer ${TOKEN}`);

  const out2 = [];
  const bad = createBridge({ endpoint: `${base}/mcp`, token: "wrong", timeoutMs: 1000, write: (m) => out2.push(m) });
  await bad.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }));
  await bad.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })); // no reply for notifications
  assert.equal(out2.length, 1);
  assert.match(out2[0].error.message, /HTTP 401.*PLCGATEWAY_TOKEN/);

  const out3 = [];
  const off = createBridge({ endpoint: `${base}/disabled/mcp`, token: TOKEN, timeoutMs: 1000, write: (m) => out3.push(m) });
  await off.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  assert.match(out3[0].error.message, /MCP may be disabled/);

  const out4 = [];
  const down = createBridge({ endpoint: "http://127.0.0.1:1/mcp", token: TOKEN, timeoutMs: 1000, write: (m) => out4.push(m) });
  await down.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
  assert.match(out4[0].error.message, /not reachable/);
});

function runBin(env, lines) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN], { env: { PATH: process.env.PATH, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "",
      stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (code) => resolve({ code, stdout, stderr }));
    for (const l of lines) p.stdin.write(l + "\n");
    p.stdin.end();
  });
}

test("binary: end-to-end over stdio; stdout carries only JSON-RPC", async () => {
  const r = await runBin({ PLCGATEWAY_URL: base, PLCGATEWAY_TOKEN: TOKEN }, [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "active_alarms", arguments: {} } }),
  ]);
  assert.equal(r.code, 0, r.stderr);
  const msgs = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(msgs.map((m) => m.id).sort(), [1, 2, 3]);
  assert.equal(msgs.find((m) => m.id === 2).result.tools[0].name, "active_alarms");
  assert.match(r.stderr, /forwarding to http:\/\/127\.0\.0\.1:\d+\/mcp/);
  assert.ok(!r.stderr.includes(TOKEN), "token never logged");
});

test("binary: missing config exits with a clear message", async () => {
  const r = await runBin({}, []);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /PLCGATEWAY_URL is not set/);
  assert.equal(r.stdout, "");
});
