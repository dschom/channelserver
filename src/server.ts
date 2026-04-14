import type { WebSocket } from "ws";
import { randomBytes } from "node:crypto";
import type { MetricsClient } from "./metrics.js";
import type { Logger } from "./logging.js";
import type { Settings } from "./settings.js";

const EOL = "\x04";

export enum DisconnectReason {
  None = "Client Disconnect",
  ConnectionError = "Connection Error",
  Timeout = "Connection Timeout",
}

interface Session {
  sessionId: string;
  started: number; // Date.now()
  msgCount: number;
  dataExchanged: number;
  remote: string | null;
}

interface Participant {
  ws: WebSocket;
  session: Session;
}

export class ChannelServer {
  /** channelKey -> Map<sessionId, Participant> */
  private channels = new Map<string, Map<string, Participant>>();
  private log: Logger;
  private settings: Settings;
  private metrics: MetricsClient;

  constructor(settings: Settings, log: Logger, metrics: MetricsClient) {
    this.settings = settings;
    this.log = log;
    this.metrics = metrics;
  }

  connect(
    ws: WebSocket,
    channelKey: string,
    remote: string | null,
    initialConnect: boolean,
  ): { sessionId: string; channelKey: string } | null {
    const sessionId = randomBytes(8).toString("hex");

    // Does the channel exist?
    if (!this.channels.has(channelKey)) {
      if (!initialConnect) {
        this.log.warn(
          { channel: channelKey, remote_ip: remote },
          "Attempt to connect to unknown channel",
        );
        return null;
      }
      this.channels.set(channelKey, new Map());
    }

    const group = this.channels.get(channelKey)!;

    if (group.size >= this.settings.max_channel_connections) {
      this.log.warn(
        { channel: channelKey, remote_ip: remote },
        "Too many connections requested for channel",
      );
      this.metrics.increment("conn.max.conn");
      return null;
    }

    // Reconnection check: 3rd+ connection must be from a known IP
    if (group.size > 2 && !this.reconnectCheck(group, remote)) {
      this.log.error({ remote_ip: remote }, "Unexpected remote connection");
      return null;
    }

    const session: Session = {
      sessionId,
      started: Date.now(),
      msgCount: 0,
      dataExchanged: 0,
      remote,
    };

    group.set(sessionId, { ws, session });

    this.log.debug(
      { channel: channelKey, session: sessionId, remote_ip: remote },
      "New connection",
    );

    return { sessionId, channelKey };
  }

  sendMessage(
    channelKey: string,
    message: string,
    skipSessionId: string,
  ): boolean {
    const group = this.channels.get(channelKey);
    if (!group) return true;

    const maxData = this.settings.max_data;
    const msgLen = Buffer.byteLength(message, "utf8");

    for (const [, participant] of group) {
      const { session } = participant;
      const remote = session.remote ?? "Unknown";

      if (maxData > 0 && (session.dataExchanged > maxData || msgLen > maxData)) {
        this.log.warn(
          { channel: channelKey, remote_ip: remote },
          "Too much data sent through channel, closing",
        );
        this.metrics.increment("conn.max.data");
        this.shutdown(channelKey);
        return false;
      }
      session.dataExchanged += msgLen;

      const maxExchanges = this.settings.max_exchanges;
      session.msgCount += 1;
      if (maxExchanges > 0 && session.msgCount > maxExchanges) {
        this.log.warn(
          { channel: channelKey, remote_ip: remote },
          "Too many messages through channel, closing",
        );
        this.metrics.increment("conn.max.msg");
        this.shutdown(channelKey);
        return false;
      }

      if (session.sessionId !== skipSessionId) {
        if (participant.ws.readyState === participant.ws.OPEN) {
          participant.ws.send(message);
        }
      }
    }
    return true;
  }

  disconnect(channelKey: string, sessionId: string): void {
    const group = this.channels.get(channelKey);
    if (!group) return;

    const participant = group.get(sessionId);
    if (participant) {
      this.log.debug({ session: sessionId }, "Sending disconnect");
      this.closeWs(participant.ws);
    }

    group.delete(sessionId);

    if (group.size === 0) {
      this.shutdown(channelKey);
    }
  }

  shutdown(channelKey: string): void {
    const group = this.channels.get(channelKey);
    if (group) {
      for (const [, participant] of group) {
        this.closeWs(participant.ws);
      }
    }
    this.log.debug({ channel: channelKey }, "Removing channel");
    this.channels.delete(channelKey);
  }

  private closeWs(ws: WebSocket): void {
    try {
      ws.terminate();
    } catch {
      // ignore errors on close
    }
  }

  private reconnectCheck(
    group: Map<string, Participant>,
    newRemote: string | null,
  ): boolean {
    if (!newRemote) return false;
    for (const [, participant] of group) {
      if (participant.session.remote === newRemote) {
        return true;
      }
    }
    return false;
  }
}
