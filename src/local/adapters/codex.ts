// Codex Adapter — 将请求转发到 OpenAI Codex CLI
// 路由: /codex/**
//
// 用法:
//   POST /codex                → codex exec "消息"
//   POST /codex?model=o3       → codex exec -m o3 "消息"
//
// Body:
//   { "message": "你好", "cwd": "/path/to/project", "model": "o3" }
//   或纯文本

import { spawn } from "child_process";
import { Adapter, InboundRequest, InboundResponse } from "../router";

interface CodexConfig {
  codexBin?: string;       // codex 二进制路径，默认 "codex"
  defaultCwd?: string;     // 默认工作目录
  timeout?: number;        // 超时毫秒，默认 600000
  model?: string;          // 默认模型
  sandbox?: string;        // sandbox 模式，默认 "read-only"
}

export class CodexAdapter implements Adapter {
  name = "codex";
  private config: CodexConfig;

  constructor(config: CodexConfig = {}) {
    this.config = {
      codexBin: config.codexBin || "codex",
      defaultCwd: config.defaultCwd || process.cwd(),
      timeout: config.timeout || 600_000,
      model: config.model,
      sandbox: config.sandbox || "read-only",
    };
  }

  match(req: InboundRequest): boolean {
    return req.path.startsWith("/codex");
  }

  async handle(req: InboundRequest): Promise<InboundResponse> {
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

    // query param model 优先
    const url = new URL(`http://localhost${req.path}`);
    const qModel = url.searchParams.get("model");
    if (qModel) model = qModel;

    console.log(`[codex] ← ${message.slice(0, 80)}${message.length > 80 ? "..." : ""}`);

    try {
      const result = await this.runCodex({ message, cwd, model });
      console.log(`[codex] → ${result.slice(0, 80)}${result.length > 80 ? "..." : ""}`);
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: true, agent: "codex", response: result }),
      };
    } catch (err: any) {
      console.error(`[codex] Error: ${err.message}`);
      return {
        status: 500,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "Codex execution failed", detail: err.message }),
      };
    }
  }

  private runCodex(opts: {
    message: string;
    cwd: string;
    model?: string;
  }): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = ["exec", opts.message];

      const model = opts.model || this.config.model;
      if (model) args.push("-m", model);
      args.push("-s", this.config.sandbox!);

      const child = spawn(this.config.codexBin!, args, {
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
