// SPDX-License-Identifier: MIT
/**
 * plcgateway-mcp — stdio bridge to the MCP server built into PLCGateway.
 *
 * MCP clients that launch servers as a command (stdio) start this bridge; it forwards each
 * JSON-RPC message to your PLCGateway's Streamable HTTP endpoint (POST <url>/mcp) with your
 * API token and writes the replies back. PLCGateway runs on your premises; this bridge runs on
 * the same machine as the AI client and talks only to the PLCGateway URL you configure.
 *
 * Configuration (environment or flags):
 *   PLCGATEWAY_URL      --url      e.g. http://192.168.1.50:8080   (required; "/mcp" is added if missing)
 *   PLCGATEWAY_TOKEN    --token    API token or MCP configuration token (required)
 *   PLCGATEWAY_TIMEOUT  --timeout  request timeout in seconds (default 120)
 *
 * If PLCGateway cannot be reached when the client connects, the bridge stays up in offline mode:
 * it offers one tool, connection_status, that says what is wrong, and it switches to the real
 * tool list by itself once PLCGateway answers.
 *
 * No dependencies; Node.js 18+.
 */
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

// ------------------------------------------------------------------ config

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--version" || a === "-v") out.version = true;
    else if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=", 2);
      out[k] = inline ?? argv[++i];
    }
  }
  return out;
}

const HELP = `plcgateway-mcp ${VERSION} — stdio bridge to PLCGateway's MCP server

Usage:
  PLCGATEWAY_URL=http://<host>:8080 PLCGATEWAY_TOKEN=<token> npx -y @plcgateway/mcp

Options (override the environment):
  --url <url>        PLCGateway address, e.g. http://192.168.1.50:8080
  --token <token>    API token (Settings → API token) or MCP configuration token
  --timeout <sec>    request timeout, default 120
  -h, --help         this help
  -v, --version      version

The token is read from the environment by preference; passing it as a flag can expose it in process lists.
`;

export function resolveConfig(env = process.env, argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return { help: true };
  if (args.version) return { version: true };
  const rawUrl = args.url ?? env.PLCGATEWAY_URL;
  const token = args.token ?? env.PLCGATEWAY_TOKEN;
  const timeout = Number(args.timeout ?? env.PLCGATEWAY_TIMEOUT ?? 120);
  const problems = [];
  let endpoint = null;
  if (!rawUrl) problems.push("PLCGATEWAY_URL is not set (e.g. http://192.168.1.50:8080)");
  else {
    try {
      const u = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`);
      if (!/\/mcp\/?$/.test(u.pathname)) u.pathname = u.pathname.replace(/\/?$/, "/mcp");
      u.pathname = u.pathname.replace(/\/$/, "");
      endpoint = u.toString();
    } catch {
      problems.push(`PLCGATEWAY_URL is not a valid URL: ${rawUrl}`);
    }
  }
  if (!token) problems.push("PLCGATEWAY_TOKEN is not set (PLCGateway → Settings → API token)");
  if (!Number.isFinite(timeout) || timeout <= 0) problems.push("PLCGATEWAY_TIMEOUT must be a positive number of seconds");
  return { endpoint, token, timeoutMs: timeout * 1000, problems };
}

// ------------------------------------------------------------------ bridge

const log = (...a) => process.stderr.write(`[plcgateway-mcp] ${a.join(" ")}\n`);

/** Parse a text/event-stream body into the JSON payloads of its "data:" fields. */
export function parseSse(text) {
  const out = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data.trim()) out.push(JSON.parse(data));
  }
  return out;
}

const FALLBACK_PROTOCOL = "2025-06-18";
const CONNECT_TIMEOUT_MS = 8000; // initialize is quick; do not make the client wait the full request timeout
const RETRY_EVERY_MS = 15000;

const STATUS_TOOL = {
  name: "connection_status",
  title: "PLCGateway connection status",
  description:
    "Report whether the bridge can reach PLCGateway and, if not, why and what to check (address, token, MCP setting). " +
    "While PLCGateway is unreachable this is the only tool; the plant tools (tags, alarms, history, OEE, reports) appear once it answers.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
};

export function createBridge({ endpoint, token, timeoutMs, write, fetchImpl = fetch, now = Date.now }) {
  let sessionId = null;
  let protocolVersion = null;
  let lastFailure = null; // why the most recent forward failed, or null
  let offline = false;
  let offlineReason = null;
  let initMsg = null;
  let lastRetry = 0;
  let connecting = Promise.resolve(); // settles when the client's initialize has been answered

  const errorFor = (msg, code, message) =>
    msg && msg.id !== undefined && msg.id !== null && msg.method ? { jsonrpc: "2.0", id: msg.id, error: { code, message } } : null;

  async function forward(msg, limitMs = timeoutMs) {
    lastFailure = null;
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "user-agent": `plcgateway-mcp/${VERSION}`,
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion;

    let res;
    try {
      res = await fetchImpl(endpoint, { method: "POST", headers, body: JSON.stringify(msg), signal: AbortSignal.timeout(limitMs) });
    } catch (e) {
      const reason = e?.name === "TimeoutError" ? `timed out after ${limitMs / 1000}s` : e?.cause?.code ?? e?.cause?.errors?.[0]?.code ?? e?.cause?.message ?? e?.message ?? String(e);
      log(`cannot reach ${endpoint}: ${reason}`);
      lastFailure = `PLCGateway not reachable at ${endpoint}: ${reason}`;
      return [errorFor(msg, -32000, `PLCGateway not reachable at ${endpoint}: ${reason}`)].filter(Boolean);
    }

    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;

    if (res.status === 202 || res.status === 204) return [];
    const text = await res.text();
    if (!res.ok) {
      const hint =
        res.status === 401 || res.status === 403
          ? "check PLCGATEWAY_TOKEN (Settings → API token)"
          : res.status === 404
            ? "MCP may be disabled in PLCGateway settings, or the URL is wrong"
            : text.slice(0, 200);
      log(`HTTP ${res.status} from ${endpoint}: ${hint}`);
      lastFailure = `PLCGateway returned HTTP ${res.status}: ${hint}`;
      return [errorFor(msg, -32000, `PLCGateway returned HTTP ${res.status}: ${hint}`)].filter(Boolean);
    }
    if (!text.trim()) return [];
    let replies;
    try {
      const ct = res.headers.get("content-type") ?? "";
      replies = ct.includes("text/event-stream") ? parseSse(text) : [JSON.parse(text)];
    } catch (e) {
      log(`invalid response from PLCGateway: ${e.message}`);
      lastFailure = "Invalid response from PLCGateway";
      return [errorFor(msg, -32603, "Invalid response from PLCGateway")].filter(Boolean);
    }
    const flat = replies.flat();
    for (const r of flat) {
      if (msg.method === "initialize" && r?.result?.protocolVersion) protocolVersion = r.result.protocolVersion;
    }
    return flat;
  }

  // ---- offline mode: PLCGateway did not answer the client's initialize

  const statusText = () =>
    offline
      ? `Not connected. ${offlineReason}\n\nCheck: PLCGateway is running and reachable from this computer at ${endpoint}; ` +
        "MCP is enabled in PLCGateway settings; PLCGATEWAY_TOKEN is the current API token (Settings → API token). " +
        "The bridge retries by itself; the plant tools appear when PLCGateway answers."
      : `Connected to PLCGateway at ${endpoint}.`;

  /** Replay the client's initialize against PLCGateway; on success leave offline mode. */
  async function tryReconnect() {
    if (now() - lastRetry < RETRY_EVERY_MS) return false;
    lastRetry = now();
    const replies = await forward(initMsg, Math.min(timeoutMs, CONNECT_TIMEOUT_MS));
    if (lastFailure || !replies.some((r) => r?.result)) {
      offlineReason = lastFailure ?? offlineReason;
      return false;
    }
    await forward({ jsonrpc: "2.0", method: "notifications/initialized" });
    offline = false;
    log(`connected to ${endpoint}`);
    write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    return true;
  }

  function answerOffline(msg) {
    if (msg.id === undefined || msg.id === null || !msg.method) return []; // notifications and stray replies
    const ok = (result) => [{ jsonrpc: "2.0", id: msg.id, result }];
    if (msg.method === "ping") return ok({});
    if (msg.method === "tools/list") return ok({ tools: [STATUS_TOOL] });
    if (msg.method === "tools/call") {
      const isStatus = msg.params?.name === STATUS_TOOL.name;
      return ok({ content: [{ type: "text", text: statusText() }], isError: !isStatus });
    }
    return [{ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: offlineReason } }];
  }

  async function handle(msg) {
    if (msg?.method === "initialize") {
      // Lines arrive concurrently; later messages wait until we know whether we are online.
      let done;
      connecting = new Promise((r) => (done = r));
      try {
        return await connect(msg);
      } finally {
        done();
      }
    }
    await connecting;
    if (offline) {
      const isRequest = msg?.id !== undefined && msg?.id !== null && msg?.method;
      if (!isRequest || !(await tryReconnect())) return answerOffline(msg ?? {});
    }
    return forward(msg);
  }

  async function connect(msg) {
    initMsg = msg;
    offline = false;
    const replies = await forward(msg, Math.min(timeoutMs, CONNECT_TIMEOUT_MS));
    if (!lastFailure) return replies;
    offline = true;
    offlineReason = lastFailure;
    lastRetry = now();
    log("starting in offline mode; only connection_status is available until PLCGateway answers");
    return [
      {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? FALLBACK_PROTOCOL,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "plcgateway-mcp", title: "PLCGateway (not connected)", version: VERSION },
          instructions: `PLCGateway is not reachable yet. Call ${STATUS_TOOL.name} to see why.`,
        },
      },
    ];
  }

  return {
    async handleLine(line) {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        return;
      }
      const batch = Array.isArray(msg) ? msg : [msg];
      for (const m of batch) for (const r of await handle(m)) write(r);
    },
    async close() {
      if (!sessionId) return;
      try {
        await fetchImpl(endpoint, { method: "DELETE", headers: { authorization: `Bearer ${token}`, "mcp-session-id": sessionId }, signal: AbortSignal.timeout(3000) });
      } catch {
        /* best effort */
      }
    },
  };
}

// ------------------------------------------------------------------ main

export async function main() {
  const cfg = resolveConfig();
  if (cfg.help) return void process.stdout.write(HELP);
  if (cfg.version) return void process.stdout.write(VERSION + "\n");
  if (cfg.problems.length) {
    for (const p of cfg.problems) log(p);
    log("see --help");
    process.exit(2);
  }

  const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  const bridge = createBridge({ endpoint: cfg.endpoint, token: cfg.token, timeoutMs: cfg.timeoutMs, write });
  log(`forwarding to ${cfg.endpoint}`);

  const pending = new Set();
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const p = bridge.handleLine(line).catch((e) => log(`unexpected error: ${e?.stack ?? e}`));
    pending.add(p);
    p.finally(() => pending.delete(p));
  });
  rl.on("close", async () => {
    await Promise.allSettled([...pending]);
    await bridge.close();
    process.exit(0);
  });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => rl.close());
}
