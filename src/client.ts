#!/usr/bin/env node

// Relay Client — 本地服务端连接中继
// 用法: npx tsx src/client.ts --relay <url> --tunnel <id> --agent <name> --token <token> --target <url>

import WebSocket from "ws";
import os from "os";

interface TunnelMessage {
  type: string;
  id?: string;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
  status?: number;
  tunnelId?: string;
  message?: string;
}

interface ClientOptions {
  relayUrl: string;
  tunnelId: string;
  agentId: string;
  targetUrl: string;
  authToken?: string;
  reconnect?: boolean;
  reconnectInterval?: number;
}

class RelayClient {
  private ws: WebSocket | null = null;
  private options: ClientOptions;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private alive = true;

  constructor(options: ClientOptions) {
    this.options = {
      reconnect: true,
      reconnectInterval: 3000,
      ...options,
    };
  }

  private authHeaders(): Record<string, string> {
    if (!this.options.authToken) return {};
    return { Authorization: `Bearer ${this.options.authToken}` };
  }

  async connect(): Promise<void> {
    const wsUrl = this.options.relayUrl
      .replace("https://", "wss://")
      .replace("http://", "ws://");

    // WebSocket can't send custom headers in browser, use query param
    const tokenParam = this.options.authToken ? `?token=${this.options.authToken}` : "";
    const connectUrl = `${wsUrl}/tunnel/${this.options.tunnelId}/connect${tokenParam}`;

    console.log(`[relay] Connecting: ${this.options.agentId} → ${this.options.tunnelId}`);

    this.ws = new WebSocket(connectUrl);

    this.ws.on("open", async () => {
      console.log(`[relay] Connected.`);
      console.log(`[relay]   agent:    ${this.options.agentId}`);
      console.log(`[relay]   tunnel:   ${this.options.tunnelId}`);
      console.log(`[relay]   target:   ${this.options.targetUrl}`);
      console.log(`[relay]   external: ${this.options.relayUrl}/agent/${this.options.agentId}/`);

      // Register with registry
      await this.register();

      // Start heartbeat (keep WebSocket alive + registry heartbeat)
      this.startHeartbeat();
    });

    this.ws.on("message", async (data: WebSocket.RawData) => {
      try {
        const msg: TunnelMessage = JSON.parse(data.toString());
        await this.handleMessage(msg);
      } catch (err: any) {
        console.error("[relay] Failed to handle message:", err.message);
      }
    });

    this.ws.on("close", async (code: number, reason: Buffer) => {
      console.log(`[relay] Disconnected (${code}: ${reason?.toString() || "no reason"})`);
      this.ws = null;
      this.stopHeartbeat();

      // Unregister from registry
      await this.unregister().catch(() => {});

      if (this.alive && this.options.reconnect) {
        console.log(`[relay] Reconnecting in ${this.options.reconnectInterval}ms...`);
        this.reconnectTimer = setTimeout(() => this.connect(), this.options.reconnectInterval);
      }
    });

    this.ws.on("error", (err: Error) => {
      console.error("[relay] WebSocket error:", err.message);
    });
  }

  private accessToken: string | null = null;

  getAccessToken(): string | null {
    return this.accessToken;
  }

  private async register(): Promise<void> {
    try {
      const resp = await fetch(`${this.options.relayUrl}/registry/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.authHeaders() },
        body: JSON.stringify({
          agentId: this.options.agentId,
          tunnelId: this.options.tunnelId,
          connectedAt: new Date().toISOString(),
          metadata: {
            hostname: os.hostname(),
            platform: os.platform(),
            target: this.options.targetUrl,
          },
        }),
      });
      if (resp.ok) {
        const data = await resp.json() as any;
        this.accessToken = data.agent?.accessToken || null;
        console.log(`[relay] Registered as: ${this.options.agentId}`);
        if (this.accessToken) {
          console.log(`[relay] Access token: ${this.accessToken}`);
          console.log(`[relay] External call:`);
          console.log(`[relay]   curl ${this.options.relayUrl}/agent/${this.options.agentId}/ -H "Authorization: Bearer ${this.accessToken}"`);
          // 写入本地文件供 okit 读取
          this.saveAccessToken();
        }
      }
    } catch (err: any) {
      console.error("[relay] Registration failed:", err.message);
    }
  }

  private saveAccessToken(): void {
    if (!this.accessToken) return;
    try {
      const fs = require("fs");
      const path = require("path");
      const dir = path.join(process.env.HOME || "~", ".okit", "relay");
      fs.mkdirSync(dir, { recursive: true });
      const tokensFile = path.join(dir, "tokens.json");
      let tokens: Record<string, string> = {};
      try {
        tokens = JSON.parse(fs.readFileSync(tokensFile, "utf-8"));
      } catch {}
      tokens[this.options.agentId] = this.accessToken;
      fs.writeFileSync(tokensFile, JSON.stringify(tokens, null, 2));
    } catch {}
  }

  private async unregister(): Promise<void> {
    try {
      await fetch(`${this.options.relayUrl}/registry/unregister`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.authHeaders() },
        body: JSON.stringify({ agentId: this.options.agentId }),
      });
    } catch {
      // Best effort
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(async () => {
      // WebSocket keep-alive
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "pong" }));
      }
      // Registry heartbeat
      try {
        await fetch(`${this.options.relayUrl}/registry/heartbeat`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...this.authHeaders() },
          body: JSON.stringify({ agentId: this.options.agentId }),
        });
      } catch {
        // Best effort
      }
    }, 25000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async handleMessage(msg: TunnelMessage): Promise<void> {
    if (msg.type === "connected") {
      return;
    }

    if (msg.type === "ping") {
      this.ws?.send(JSON.stringify({ type: "pong" }));
      return;
    }

    if (msg.type !== "request" || !msg.id) return;

    const { id, method, path, headers, body } = msg;
    const targetUrl = `${this.options.targetUrl}${path}`;

    console.log(`[relay] → ${method} ${path}`);

    try {
      const resp = await fetch(targetUrl, {
        method: method || "GET",
        headers: headers || {},
        body: method !== "GET" && method !== "HEAD" ? body : undefined,
      });

      const respBody = await resp.text();
      const respHeaders: Record<string, string> = {};
      resp.headers.forEach((value: string, key: string) => {
        respHeaders[key] = value;
      });

      const response: TunnelMessage = {
        type: "response",
        id,
        status: resp.status,
        headers: respHeaders,
        body: respBody,
      };

      this.ws?.send(JSON.stringify(response));
      console.log(`[relay] ← ${resp.status} ${method} ${path}`);
    } catch (err: any) {
      const response: TunnelMessage = {
        type: "response",
        id,
        status: 502,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "Local target error", detail: err.message }),
      };

      this.ws?.send(JSON.stringify(response));
      console.error(`[relay] ✗ ${method} ${path}: ${err.message}`);
    }
  }

  sendLog(level: string, message: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: "log",
        level,
        message,
        timestamp: new Date().toISOString(),
      }));
    }
  }

  async disconnect(): Promise<void> {
    this.alive = false;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this.unregister().catch(() => {});
    if (this.ws) {
      this.ws.close(1000, "client disconnect");
      this.ws = null;
    }
  }
}

// CLI entry
async function main() {
  const args = process.argv.slice(2);
  const flags: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length) {
      flags[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }

  const relay = flags.relay;
  const tunnel = flags.tunnel;
  const agent = flags.agent;
  const target = flags.target || "http://localhost:3000";
  const token = flags.token;

  if (!relay || !tunnel || !agent) {
    console.log("Usage: relay-client --relay <url> --tunnel <id> --agent <name> [--target <url>] [--token <token>]");
    console.log("");
    console.log("Options:");
    console.log("  --relay   Relay server URL");
    console.log("  --tunnel  Tunnel ID (connection channel)");
    console.log("  --agent   Agent name (registered in registry, used for routing)");
    console.log("  --target  Local target URL (default: http://localhost:3000)");
    console.log("  --token   Auth token");
    process.exit(1);
  }

  const client = new RelayClient({
    relayUrl: relay,
    tunnelId: tunnel,
    agentId: agent,
    targetUrl: target,
    authToken: token,
  });

  process.on("SIGINT", async () => {
    console.log("\n[relay] Shutting down...");
    await client.disconnect();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await client.disconnect();
    process.exit(0);
  });

  await client.connect();
}

main().catch(console.error);

export { RelayClient };
