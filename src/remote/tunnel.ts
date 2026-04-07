// Tunnel Durable Object
// 管理本地服务端的 WebSocket 连接，转发外部请求
// 使用 Hibernation API 保持长连接（DO 空闲时不被驱逐）

export interface TunnelMessage {
  type: "request" | "response" | "connected" | "ping" | "pong" | "log" | "subscribe_logs" | "unsubscribe_logs";
  id?: string;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
  status?: number;
  tunnelId?: string;
  message?: string;
  timestamp?: string;
  level?: string;
}

export class Tunnel implements DurableObject {
  private pendingRequests: Map<string, {
    resolve: (msg: TunnelMessage) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = new Map();
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  /** 通过 hibernation API 获取 local WebSocket（DO 唤醒后也有效） */
  private getLocalSocket(): WebSocket | null {
    const sockets = this.state.getWebSockets("local");
    return sockets.length > 0 ? sockets[0] : null;
  }

  private getLogSubscribers(): WebSocket[] {
    return this.state.getWebSockets("logs");
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Local server connects via WebSocket
    if (path === "/connect") {
      return this.handleLocalConnect(request);
    }

    // External client subscribes to logs via WebSocket
    if (path === "/logs") {
      return this.handleLogSubscribe(request);
    }

    // Status check
    if (path === "/status") {
      return Response.json({
        connected: this.getLocalSocket() !== null,
        pendingRequests: this.pendingRequests.size,
        logSubscribers: this.getLogSubscribers().length,
      });
    }

    // Forward any other request to local server
    return this.forwardToLocal(request, path);
  }

  private handleLocalConnect(request: Request): Response {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // If there's already a connection, close it
    const existing = this.getLocalSocket();
    if (existing) {
      try { existing.close(1000, "replaced"); } catch {}
    }

    // 使用 hibernation API — DO 休眠后 WebSocket 仍由运行时维持
    this.state.acceptWebSocket(server, ["local"]);

    // Send connected confirmation
    server.send(JSON.stringify({
      type: "connected",
      tunnelId: this.state.id.toString(),
    } satisfies TunnelMessage));

    return new Response(null, { status: 101, webSocket: client });
  }

  private handleLogSubscribe(request: Request): Response {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.state.acceptWebSocket(server, ["logs"]);

    server.send(JSON.stringify({ type: "connected", message: "Subscribed to logs" }));

    return new Response(null, { status: 101, webSocket: client });
  }

  private async forwardToLocal(request: Request, path: string): Promise<Response> {
    const localSocket = this.getLocalSocket();
    if (!localSocket || localSocket.readyState !== 1) {
      return Response.json(
        { error: "Tunnel not connected", hint: "Local server is offline", readyState: localSocket?.readyState },
        { status: 502 }
      );
    }

    const id = crypto.randomUUID();

    // Read request body
    let body: string | undefined;
    if (request.method !== "GET" && request.method !== "HEAD") {
      body = await request.text();
    }

    // Convert headers
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      if (!["host", "connection", "upgrade", "transfer-encoding"].includes(key.toLowerCase())) {
        headers[key] = value;
      }
    });

    const msg: TunnelMessage = {
      type: "request",
      id,
      method: request.method,
      path,
      headers,
      body,
    };

    try {
      localSocket.send(JSON.stringify(msg));
    } catch (err: any) {
      return Response.json(
        { error: "Tunnel connection lost", detail: err?.message },
        { status: 502 }
      );
    }

    // Wait for response with timeout
    const timeout = 30000; // 30s
    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        resolve(Response.json(
          { error: "Timeout waiting for local server response" },
          { status: 504 }
        ));
      }, timeout);

      this.pendingRequests.set(id, {
        resolve: (resp: TunnelMessage) => {
          clearTimeout(timer);
          this.pendingRequests.delete(id);

          const respHeaders = new Headers(resp.headers || {});
          resolve(new Response(resp.body || null, {
            status: resp.status || 200,
            headers: respHeaders,
          }));
        },
        timer,
      });
    });
  }

  // Hibernation API 回调 — DO 被消息唤醒时调用
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const data = typeof message === "string" ? message : new TextDecoder().decode(message);
    let msg: TunnelMessage;

    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    const tags = this.state.getTags(ws);

    if (tags.includes("local")) {
      switch (msg.type) {
        case "response":
          if (msg.id && this.pendingRequests.has(msg.id)) {
            this.pendingRequests.get(msg.id)!.resolve(msg);
          }
          break;

        case "pong":
          break;

        case "log":
          const logMsg = JSON.stringify(msg);
          for (const sub of this.getLogSubscribers()) {
            try { sub.send(logMsg); } catch {}
          }
          break;
      }
    } else if (tags.includes("logs")) {
      if (msg.type === "unsubscribe_logs") {
        ws.close(1000, "unsubscribed");
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const tags = this.state.getTags(ws);

    if (tags.includes("local")) {
      // Cancel all pending requests
      for (const [id, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.resolve({
          type: "response",
          id,
          status: 502,
          body: JSON.stringify({ error: "Local server disconnected" }),
          headers: { "content-type": "application/json" },
        });
      }
      this.pendingRequests.clear();
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }
}
