// Router — 根据请求路径分发到不同 adapter
// 支持注册自定义 adapter，fallback 到 HTTP 转发

export interface InboundRequest {
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

export interface InboundResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface Adapter {
  name: string;
  // 匹配请求，返回 true 表示该 adapter 处理
  match(req: InboundRequest): boolean;
  // 处理请求
  handle(req: InboundRequest): Promise<InboundResponse>;
  // 初始化（可选）
  init?(): Promise<void>;
  // 销毁（可选）
  destroy?(): Promise<void>;
}

export class Router {
  private adapters: Adapter[] = [];
  private fallback: ((req: InboundRequest) => Promise<InboundResponse>) | null = null;

  use(adapter: Adapter): void {
    this.adapters.push(adapter);
  }

  setFallback(handler: (req: InboundRequest) => Promise<InboundResponse>): void {
    this.fallback = handler;
  }

  async route(req: InboundRequest): Promise<InboundResponse> {
    for (const adapter of this.adapters) {
      if (adapter.match(req)) {
        console.log(`[router] ${req.method} ${req.path} → ${adapter.name}`);
        return adapter.handle(req);
      }
    }

    if (this.fallback) {
      console.log(`[router] ${req.method} ${req.path} → fallback`);
      return this.fallback(req);
    }

    return {
      status: 404,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        error: "No adapter matched",
        path: req.path,
        adapters: this.adapters.map(a => a.name),
      }),
    };
  }

  async initAll(): Promise<void> {
    for (const adapter of this.adapters) {
      if (adapter.init) await adapter.init();
    }
  }

  async destroyAll(): Promise<void> {
    for (const adapter of this.adapters) {
      if (adapter.destroy) await adapter.destroy();
    }
  }
}
