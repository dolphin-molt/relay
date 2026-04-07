// Claude Adapter — 将请求转发到 Claude Code CLI
// 路由: /claude/**
//
// 用法:
//   POST /claude                        → claude -p "消息"
//   POST /claude/agent-name             → claude --agent agent-name -p "消息"
//   POST /claude?resume=1               → claude -c -p "消息"（继续对话）
//
// Body:
//   { "message": "你好", "cwd": "/path/to/project", "model": "sonnet" }
//   或纯文本

import { spawn } from "child_process";
import { Adapter, InboundRequest, InboundResponse } from "../router";

interface ClaudeConfig {
  claudeBin?: string;      // claude 二进制路径，默认 "claude"
  defaultCwd?: string;     // 默认工作目录
  timeout?: number;        // 超时毫秒，默认 600000
  model?: string;          // 默认模型
  permissionMode?: string; // 权限模式，默认 "bypassPermissions"
}

export class ClaudeAdapter implements Adapter {
  name = "claude";
  private config: ClaudeConfig;

  constructor(config: ClaudeConfig = {}) {
    this.config = {
      claudeBin: config.claudeBin || "claude",
      defaultCwd: config.defaultCwd || process.cwd(),
      timeout: config.timeout || 600_000,
      model: config.model,
      permissionMode: config.permissionMode || "bypassPermissions",
    };
  }

  match(req: InboundRequest): boolean {
    return req.path.startsWith("/claude");
  }

  async handle(req: InboundRequest): Promise<InboundResponse> {
    const parts = req.path.split("/").filter(Boolean);
    // parts[0] = "claude"
    const agentName = parts[1] || undefined;

    let message = "";
    let cwd = this.config.defaultCwd!;
    let model: string | undefined;
    try {
      const body = JSON.parse(req.body);
      message = body.message || body.text || body.content || req.body;
      if (body.cwd) cwd = body.cwd;
      if (body.model) model = body.model;
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

    const url = new URL(`http://localhost${req.path}`);
    const resume = url.searchParams.get("resume") === "1";

    console.log(`[claude] ${agentName || "default"} ← ${message.slice(0, 80)}${message.length > 80 ? "..." : ""}`);

    try {
      const result = await this.runClaude({ message, agentName, cwd, model, resume });
      console.log(`[claude] ${agentName || "default"} → ${result.slice(0, 80)}${result.length > 80 ? "..." : ""}`);
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: true, agent: agentName || "default", response: result }),
      };
    } catch (err: any) {
      console.error(`[claude] Error: ${err.message}`);
      return {
        status: 500,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "Claude execution failed", detail: err.message }),
      };
    }
  }

  private runClaude(opts: {
    message: string;
    agentName?: string;
    cwd: string;
    model?: string;
    resume: boolean;
  }): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = ["-p", opts.message, "--output-format", "text"];

      if (opts.agentName) args.push("--agent", opts.agentName);
      if (opts.resume) args.push("-c");

      const model = opts.model || this.config.model;
      if (model) args.push("--model", model);

      args.push("--permission-mode", this.config.permissionMode!);

      const child = spawn(this.config.claudeBin!, args, {
        cwd: opts.cwd,
        env: { ...process.env },
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
          resolve(stdout.trim());
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
