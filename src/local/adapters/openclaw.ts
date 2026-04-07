// OpenClaw Adapter — 将请求转发到 OpenClaw agent
// 路由: /openclaw/**  或 /claude/**
//
// 用法:
//   POST /openclaw/agent-name           → openclaw agent --agent agent-name --local -m "消息"
//   POST /openclaw/agent-name?resume=1  → openclaw agent --agent agent-name --local -m "消息" --session-id <id>
//   POST /claude                        → openclaw agent --local -m "消息"（默认 agent）
//
// Body:
//   { "message": "你好", "cwd": "/path/to/project" }
//   或纯文本

import { spawn } from "child_process";
import { Adapter, InboundRequest, InboundResponse } from "../router";

interface OpenClawConfig {
  openclawBin?: string;    // openclaw 二进制路径，默认 "openclaw"
  defaultCwd?: string;     // 默认工作目录
  timeout?: number;        // 超时毫秒，默认 600000（openclaw 默认 600s）
}

export class OpenClawAdapter implements Adapter {
  name = "openclaw";
  private config: OpenClawConfig;

  constructor(config: OpenClawConfig = {}) {
    this.config = {
      openclawBin: config.openclawBin || "openclaw",
      defaultCwd: config.defaultCwd || process.cwd(),
      timeout: config.timeout || 600_000,
    };
  }

  match(req: InboundRequest): boolean {
    return req.path.startsWith("/openclaw");
  }

  async handle(req: InboundRequest): Promise<InboundResponse> {
    // 解析路径: /openclaw/agent-name/... 或 /claude/...
    const parts = req.path.split("/").filter(Boolean);
    // parts[0] = "openclaw" or "claude"
    const agentName = parts[1] || undefined;

    // 解析 body
    let message = "";
    let cwd = this.config.defaultCwd!;
    let deliver = false;
    let replyChannel: string | undefined;
    let replyTo: string | undefined;
    let sessionId: string | undefined;
    try {
      const body = JSON.parse(req.body);
      message = body.message || body.text || body.content || req.body;
      if (body.cwd) cwd = body.cwd;
      if (body.deliver) deliver = true;
      if (body.replyChannel) replyChannel = body.replyChannel;
      if (body.replyTo) replyTo = body.replyTo;
      if (body.sessionId) sessionId = body.sessionId;
    } catch {
      message = req.body;
    }

    if (!message) {
      return {
        status: 400,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "No message provided" }),
      };
    }

    // 解析 query params（body 中的优先）
    const url = new URL(`http://localhost${req.path}`);
    if (!sessionId) sessionId = url.searchParams.get("session") || undefined;

    console.log(`[openclaw] ${agentName || "default"} ← ${message.slice(0, 80)}${message.length > 80 ? "..." : ""}`);
    if (deliver) console.log(`[openclaw]   deliver → ${replyChannel}:${replyTo}`);

    try {
      const result = await this.runOpenClaw({ message, agentName, cwd, sessionId, deliver, replyChannel, replyTo });
      console.log(`[openclaw] ${agentName || "default"} → ${result.slice(0, 80)}${result.length > 80 ? "..." : ""}`);
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: true, agent: agentName || "default", response: result }),
      };
    } catch (err: any) {
      console.error(`[openclaw] Error: ${err.message}`);
      return {
        status: 500,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "Agent execution failed", detail: err.message }),
      };
    }
  }

  private runOpenClaw(opts: {
    message: string;
    agentName?: string;
    cwd: string;
    sessionId?: string;
    deliver?: boolean;
    replyChannel?: string;
    replyTo?: string;
  }): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = ["agent", "--local", "-m", opts.message, "--json"];

      if (opts.agentName) {
        args.push("--agent", opts.agentName);
      }
      if (opts.sessionId) {
        args.push("--session-id", opts.sessionId);
      }
      if (opts.deliver) {
        args.push("--deliver");
      }
      if (opts.replyChannel) {
        args.push("--reply-channel", opts.replyChannel);
      }
      if (opts.replyTo) {
        args.push("--reply-to", opts.replyTo);
      }
      args.push("--timeout", String(Math.floor(this.config.timeout! / 1000)));

      // 清理代理环境变量，避免干扰飞书等外部 API
      const cleanEnv = { ...process.env };
      delete cleanEnv.HTTPS_PROXY;
      delete cleanEnv.HTTP_PROXY;
      delete cleanEnv.https_proxy;
      delete cleanEnv.http_proxy;
      cleanEnv.NO_PROXY = "*";

      const child = spawn(this.config.openclawBin!, args, {
        cwd: opts.cwd,
        env: cleanEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Timeout after ${this.config.timeout}ms`));
      }, this.config.timeout);

      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          // 尝试从 JSON 输出中提取 response
          try {
            const json = JSON.parse(stdout.trim());
            resolve(json.response || json.text || json.content || stdout.trim());
          } catch {
            resolve(stdout.trim());
          }
        } else {
          reject(new Error(`Exit ${code}: ${stderr.trim() || stdout.trim()}`));
        }
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}
