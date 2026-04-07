// HTTP Adapter — 转发请求到本地 HTTP 服务（兼容现有行为）

import { Adapter, InboundRequest, InboundResponse } from "../router";

export class HttpAdapter implements Adapter {
  name = "http";
  private targetUrl: string;

  constructor(targetUrl: string) {
    this.targetUrl = targetUrl;
  }

  match(_req: InboundRequest): boolean {
    // 作为 fallback 使用，不主动匹配
    return false;
  }

  async handle(req: InboundRequest): Promise<InboundResponse> {
    const url = `${this.targetUrl}${req.path}`;
    try {
      const resp = await fetch(url, {
        method: req.method || "GET",
        headers: req.headers || {},
        body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
      });

      const body = await resp.text();
      const headers: Record<string, string> = {};
      resp.headers.forEach((v, k) => { headers[k] = v; });

      return { status: resp.status, headers, body };
    } catch (err: any) {
      return {
        status: 502,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "Target unreachable", detail: err.message }),
      };
    }
  }
}
