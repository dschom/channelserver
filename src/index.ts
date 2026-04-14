import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { Reader } from "@maxmind/geoip2-node";

import { loadSettings } from "./settings.js";
import { createLogger } from "./logging.js";
import { createMetrics } from "./metrics.js";
import { ChannelServer } from "./server.js";
import { ChannelID } from "./channelid.js";
import { buildSenderData, buildTrustedProxyList, type SenderData } from "./meta.js";

const settings = loadSettings();
const log = createLogger(settings.human_logs);
const metrics = createMetrics(settings, log);

// Load GeoIP database
const mmdbPath = resolve(settings.mmdb_loc);
if (!existsSync(mmdbPath)) {
  log.error({ path: mmdbPath }, "Cannot find geoip database");
  process.exit(1);
}
const iploc = Reader.openBuffer(readFileSync(mmdbPath));

const trustedProxyList = buildTrustedProxyList(settings.trusted_proxy_list);
const channelServer = new ChannelServer(settings, log, metrics);

// Load version.json (try cwd, then parent — handles both container and dev layouts)
let versionJson = '{"build":"TBD","commit":"TBD","source":"TBD","version":"TBD"}';
for (const candidate of [resolve("version.json"), resolve("../version.json")]) {
  if (existsSync(candidate)) {
    versionJson = readFileSync(candidate, "utf8");
    break;
  }
}

// --- HTTP server ---

function getPeerIp(req: IncomingMessage): string | undefined {
  return req.socket.remoteAddress;
}

function handleHttp(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? "/";

  if (url === "/__heartbeat__") {
    const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ version: pkg.version, status: "ok" }));
    return;
  }

  if (url === "/__lbheartbeat__") {
    res.writeHead(200);
    res.end();
    return;
  }

  if (url === "/__version__") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(versionJson);
    return;
  }

  // All other non-websocket requests
  res.writeHead(404);
  res.end();
}

const server = createServer(handleHttp);
const wss = new WebSocketServer({ noServer: true });

// --- WebSocket upgrade ---

server.on("upgrade", (req, socket, head) => {
  const url = req.url ?? "";

  // Only accept /v1/ws/ and /v1/ws/{channelid}
  const wsMatch = url.match(/^\/v1\/ws\/(.*)?$/);
  if (!wsMatch) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    handleWebSocket(ws, req, wsMatch[1] ?? "");
  });
});

function handleWebSocket(
  ws: WebSocket,
  req: IncomingMessage,
  channelParam: string,
): void {
  const peerIp = getPeerIp(req);
  const sender = buildSenderData(
    req,
    peerIp,
    trustedProxyList,
    iploc,
    settings.default_lang,
    log,
  );

  let channelKey: string;
  let initialConnection: boolean;

  if (!channelParam) {
    // New channel
    initialConnection = true;
    channelKey = ChannelID.generate().key;
    metrics.increment("conn.request", { tag: "new" });
  } else {
    const parsed = ChannelID.fromString(channelParam);
    if (parsed) {
      initialConnection = false;
      channelKey = parsed.key;
      metrics.increment("conn.request", { tag: "existing" });
    } else {
      log.warn({ raw: channelParam }, "Routing error: invalid channel ID");
      metrics.increment("conn.request", { tag: "error" });
      ws.terminate();
      return;
    }
  }

  const result = channelServer.connect(
    ws,
    channelKey,
    sender.remote ?? null,
    initialConnection,
  );

  if (!result) {
    ws.terminate();
    return;
  }

  const { sessionId } = result;
  metrics.increment("conn.create");

  log.debug(
    { session: sessionId, channel: channelKey, remote_ip: sender.remote },
    "Starting new session",
  );

  // Send channel info to the connecting client
  const channelInfo = JSON.stringify({
    link: `/v1/ws/${channelKey}`,
    channelid: channelKey,
  });
  ws.send(channelInfo);

  // --- Heartbeat / timeout ---
  const connStart = Date.now();
  let lastActivity = Date.now();

  const heartbeatTimer = setInterval(() => {
    const now = Date.now();

    // Client timeout (no activity)
    if (now - lastActivity > settings.client_timeout * 1000) {
      log.info(
        { session: sessionId, channel: channelKey, remote_ip: sender.remote },
        "Client connected too long",
      );
      metrics.increment("conn.expired");
      cleanup(DisconnectReason.Timeout);
      return;
    }

    // Connection lifespan exceeded
    if (now - connStart > settings.conn_lifespan * 1000) {
      log.info(
        { session: sessionId, channel: channelKey, remote_ip: sender.remote },
        "Client time-out. Disconnecting",
      );
      metrics.increment("conn.timeout");
      cleanup(DisconnectReason.Timeout);
      return;
    }

    // Send ping
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, settings.heartbeat_interval * 1000);

  const enum DisconnectReason {
    None,
    Timeout,
  }

  function cleanup(reason: DisconnectReason): void {
    clearInterval(heartbeatTimer);
    const duration = Date.now() - connStart;
    metrics.timing("conn.length", duration);
    log.debug(
      { session: sessionId, remote_ip: sender.remote, reason },
      "Killing session",
    );
    channelServer.disconnect(channelKey, sessionId);
  }

  // --- WebSocket event handlers ---

  ws.on("pong", () => {
    lastActivity = Date.now();
  });

  ws.on("message", (data, isBinary) => {
    lastActivity = Date.now();

    if (isBinary) {
      log.info({ remote_ip: sender.remote }, "Unexpected binary");
      return;
    }

    const text = data.toString("utf8").trim();

    log.debug(
      { remote_ip: sender.remote },
      "WebSocket message received",
    );

    const envelope = JSON.stringify({
      message: text,
      sender: buildSenderJson(sender),
    });

    channelServer.sendMessage(channelKey, envelope, sessionId);
  });

  ws.on("close", () => {
    cleanup(DisconnectReason.None);
  });

  ws.on("error", (err) => {
    log.error({ err, session: sessionId }, "WebSocket error");
    cleanup(DisconnectReason.None);
  });
}

function buildSenderJson(sender: SenderData): Record<string, string> {
  const obj: Record<string, string> = {};
  if (sender.remote) obj.remote = sender.remote;
  if (sender.city) obj.city = sender.city;
  if (sender.region) obj.region = sender.region;
  if (sender.country) obj.country = sender.country;
  if (sender.ua) obj.ua = sender.ua;
  return obj;
}

// --- Start ---

const addr = `${settings.hostname}:${settings.port}`;
server.listen(settings.port, settings.hostname, () => {
  log.info({ addr }, "Starting server");
});

// Graceful shutdown
function shutdown(): void {
  log.info("Shutting down");
  wss.close();
  server.close();
  metrics.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
