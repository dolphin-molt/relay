#!/usr/bin/env node

// Local Bridge — 连接 Remote Relay，路由消息到本地 adapter
//
// 架构:
//   Remote (Cloudflare/腾讯云/...) ←WebSocket→ Bridge → Router → Adapters
//
// Adapters:
//   - openclaw: 转发到 Claude Code / OpenClaw agent
//   - http: 转发到本地 HTTP 服务（fallback）
//   - 可扩展：微信、飞书等外部连接

import WebSocket from "ws";
import os from "os";
import fs from "fs";
import path from "path";
import { Router, InboundRequest, InboundResponse } from "./router";
import { OpenClawAdapter } from "./adapters/openclaw";
import { ClaudeAdapter } from "./adapters/claude";
import { CodexAdapter } from "./adapters/codex";
import { HttpAdapter } from "./adapters/http";

interface TunnelMessage {
  type: string;
  id?: string;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
  status?: number;
}

export interface BridgeOptions {
  relayUrl: string;
  tunnelId: string;
  agentId: string;
  authToken?: string;
  // Adapter 配置
  targetUrl?: string;       // HTTP fallback 地址
  enableOpenClaw?: boolean; // 启用 openclaw adapter（默认 true）
  enableClaude?: boolean;   // 启用 claude adapter（默认 true）
  enableCodex?: boolean;    // 启用 codex adapter（默认 true）
  openclawBin?: string;     // openclaw 二进制路径
  claudeBin?: string;       // claude 二进制路径
  codexBin?: string;        // codex 二进制路径
  defaultCwd?: string;      // 默认工作目录
  reconnect?: boolean;
  reconnectInterval?: number;
}

export class Bridge {
  private ws: WebSocket | null = null;
  private options: BridgeOptions;
  private router: Router;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private alive = true;
  private accessToken: string | null = null;

  constructor(options: BridgeOptions) {
    this.options = {
      enableOpenClaw: true,
      enableClaude: true,
      enableCodex: true,
      reconnect: true,
      reconnectInterval: 3000,
      ...options,
    };

    // 初始化 router
    this.router = new Router();

    // 注册 adapters — 顺序: openclaw → claude → codex → http fallback
    if (this.options.enableOpenClaw) {
      this.router.use(new OpenClawAdapter({
        openclawBin: this.options.openclawBin,
        defaultCwd: this.options.defaultCwd,
      }));
    }
    if (this.options.enableClaude) {
      this.router.use(new ClaudeAdapter({
        claudeBin: this.options.claudeBin,
        defaultCwd: this.options.defaultCwd,
      }));
    }
    if (this.options.enableCodex) {
      this.router.use(new CodexAdapter({
        codexBin: this.options.codexBin,
        defaultCwd: this.options.defaultCwd,
      }));
    }

    // HTTP fallback
    if (this.options.targetUrl) {
      const httpAdapter = new HttpAdapter(this.options.targetUrl);
      this.router.setFallback((req) => httpAdapter.handle(req));
    }
  }

  // 允许外部注册自定义 adapter
  useAdapter(adapter: any): void {
    this.router.use(adapter);
  }

  getAccessToken(): string | null {
    return this.accessToken;
  }

  private authHeaders(): Record<string, string> {
    if (!this.options.authToken) return {};
    return { Authorization: `Bearer ${this.options.authToken}` };
  }

  async connect(): Promise<void> {
    await this.router.initAll();

    const wsUrl = this.options.relayUrl
      .replace("https://", "wss://")
      .replace("http://", "ws://");

    const tokenParam = this.options.authToken ? `?token=${this.options.authToken}` : "";
    const connectUrl = `${wsUrl}/tunnel/${this.options.tunnelId}/connect${tokenParam}`;

    console.log(`[bridge] Connecting: ${this.options.agentId} → ${this.options.tunnelId}`);

    this.ws = new WebSocket(connectUrl);

    this.ws.on("open", async () => {
      console.log(`[bridge] Connected.`);
      console.log(`[bridge]   agent:    ${this.options.agentId}`);
      console.log(`[bridge]   tunnel:   ${this.options.tunnelId}`);
      if (this.options.targetUrl) {
        console.log(`[bridge]   fallback: ${this.options.targetUrl}`);
      }
      if (this.options.enableOpenClaw) console.log(`[bridge]   openclaw: enabled (/openclaw/*)`);
      if (this.options.enableClaude) console.log(`[bridge]   claude:   enabled (/claude/*)`);
      if (this.options.enableCodex) console.log(`[bridge]   codex:    enabled (/codex/*)`);

      await this.register();
      this.startHeartbeat();
    });

    this.ws.on("message", async (data: WebSocket.RawData) => {
      try {
        const msg: TunnelMessage = JSON.parse(data.toString());
        await this.handleMessage(msg);
      } catch (err: any) {
        console.error("[bridge] Failed to handle message:", err.message);
      }
    });

    this.ws.on("close", async (code: number, reason: Buffer) => {
      console.log(`[bridge] Disconnected (${code}: ${reason?.toString() || "no reason"})`);
      this.ws = null;
      this.stopHeartbeat();
      await this.unregister().catch(() => {});

      if (this.alive && this.options.reconnect) {
        console.log(`[bridge] Reconnecting in ${this.options.reconnectInterval}ms...`);
        this.reconnectTimer = setTimeout(() => this.connect(), this.options.reconnectInterval);
      }
    });

    this.ws.on("error", (err: Error) => {
      console.error("[bridge] WebSocket error:", err.message);
    });
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
            target: this.options.targetUrl || "bridge",
            openclaw: this.options.enableOpenClaw ? "enabled" : "disabled",
            claude: this.options.enableClaude ? "enabled" : "disabled",
            codex: this.options.enableCodex ? "enabled" : "disabled",
          },
        }),
      });

      const data = await resp.json() as any;

      if (!resp.ok) {
        console.error(`[bridge] ✗ Registration failed (${resp.status})`);
        if (data.error === "tunnel_not_connected") {
          console.error(`[bridge]   Tunnel WebSocket not connected`);
        } else if (data.error === "tunnel_probe_failed") {
          console.error(`[bridge]   End-to-end probe failed`);
          console.error(`[bridge]   Hint: Check adapters and fallback target`);
        } else {
          console.error(`[bridge]   Error: ${data.error || "unknown"}`);
        }
        this.accessToken = null;
        return;
      }

      this.accessToken = data.agent?.accessToken || null;
      console.log(`[bridge] ✓ Registered as: ${this.options.agentId}`);
      if (data.verified) console.log(`[bridge] ✓ Connection verified`);
      if (this.accessToken) {
        console.log(`[bridge] Access token: ${this.accessToken}`);
        this.saveAccessToken();
      }
    } catch (err: any) {
      console.error("[bridge] Registration failed:", err.message);
    }
  }

  private saveAccessToken(): void {
    if (!this.accessToken) return;
    try {
      const dir = path.join(os.homedir(), ".okit", "relay");
      fs.mkdirSync(dir, { recursive: true });
      const tokensFile = path.join(dir, "tokens.json");
      let tokens: Record<string, string> = {};
      try { tokens = JSON.parse(fs.readFileSync(tokensFile, "utf-8")); } catch {}
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
    } catch {}
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(async () => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "pong" }));
      }
      try {
        await fetch(`${this.options.relayUrl}/registry/heartbeat`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...this.authHeaders() },
          body: JSON.stringify({ agentId: this.options.agentId }),
        });
      } catch {}
    }, 25000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async handleMessage(msg: TunnelMessage): Promise<void> {
    if (msg.type === "connected") return;
    if (msg.type === "ping") {
      this.ws?.send(JSON.stringify({ type: "pong" }));
      return;
    }
    if (msg.type !== "request" || !msg.id) return;

    const request: InboundRequest = {
      id: msg.id,
      method: msg.method || "GET",
      path: msg.path || "/",
      headers: msg.headers || {},
      body: msg.body || "",
    };

    // 通过 router 分发
    const response = await this.router.route(request);

    this.ws?.send(JSON.stringify({
      type: "response",
      id: msg.id,
      status: response.status,
      headers: response.headers,
      body: response.body,
    }));
  }

  async disconnect(): Promise<void> {
    this.alive = false;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this.router.destroyAll();
    await this.unregister().catch(() => {});
    if (this.ws) {
      this.ws.close(1000, "bridge disconnect");
      this.ws = null;
    }
  }
}

// CLI 入口
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
  const target = flags.target;
  const token = flags.token;
  const cwd = flags.cwd;
  const noOpenclaw = flags["no-openclaw"] !== undefined;

  if (!relay || !tunnel || !agent) {
    console.log("Usage: bridge --relay <url> --tunnel <id> --agent <name> [options]");
    console.log("");
    console.log("Options:");
    console.log("  --relay        Relay server URL");
    console.log("  --tunnel       Tunnel ID");
    console.log("  --agent        Agent name");
    console.log("  --target       HTTP fallback URL (optional)");
    console.log("  --token        Auth token");
    console.log("  --cwd          Default working directory for openclaw");
    console.log("  --no-openclaw  Disable openclaw adapter");
    process.exit(1);
  }

  const bridge = new Bridge({
    relayUrl: relay,
    tunnelId: tunnel,
    agentId: agent,
    targetUrl: target,
    authToken: token,
    enableOpenClaw: !noOpenclaw,
    defaultCwd: cwd,
  });

  process.on("SIGINT", async () => {
    console.log("\n[bridge] Shutting down...");
    await bridge.disconnect();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await bridge.disconnect();
    process.exit(0);
  });

  await bridge.connect();
}

main().catch(console.error);
