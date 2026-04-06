// Tunnel Durable Object
// 管理本地服务端的 WebSocket 连接，转发外部请求

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
  private localSocket: WebSocket | null = null;
  private logSubscribers: Set<WebSocket> = new Set();
  private pendingRequests: Map<string, {
    resolve: (msg: TunnelMessage) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = new Map();
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
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
        connected: this.localSocket !== null,
        pendingRequests: this.pendingRequests.size,
        logSubscribers: this.logSubscribers.size,
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
    if (this.localSocket) {
      try { this.localSocket.close(1000, "replaced"); } catch {}
    }

    this.localSocket = server;
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

    this.logSubscribers.add(server);
    this.state.acceptWebSocket(server, ["logs"]);

    server.send(JSON.stringify({ type: "connected", message: "Subscribed to logs" }));

    return new Response(null, { status: 101, webSocket: client });
  }

  private async forwardToLocal(request: Request, path: string): Promise<Response> {
    if (!this.localSocket) {
      return Response.json(
        { error: "Tunnel not connected", hint: "Local server is offline" },
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
      // Skip hop-by-hop headers
      if (!["host", "connection", "upgrade", "transfer-encoding"].includes(key.toLowerCase())) {
        headers[key] = value;
      }
    });

    // Send request to local server
    const msg: TunnelMessage = {
      type: "request",
      id,
      method: request.method,
      path,
      headers,
      body,
    };

    try {
      this.localSocket.send(JSON.stringify(msg));
    } catch {
      this.localSocket = null;
      return Response.json(
        { error: "Tunnel connection lost" },
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
      // Message from local server
      switch (msg.type) {
        case "response":
          if (msg.id && this.pendingRequests.has(msg.id)) {
            this.pendingRequests.get(msg.id)!.resolve(msg);
          }
          break;

        case "pong":
          // Keep-alive response, do nothing
          break;

        case "log":
          // Broadcast log to all subscribers
          const logMsg = JSON.stringify(msg);
          for (const sub of this.logSubscribers) {
            try { sub.send(logMsg); } catch {
              this.logSubscribers.delete(sub);
            }
          }
          break;
      }
    } else if (tags.includes("logs")) {
      // Message from log subscriber
      if (msg.type === "unsubscribe_logs") {
        this.logSubscribers.delete(ws);
        ws.close(1000, "unsubscribed");
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const tags = this.state.getTags(ws);

    if (tags.includes("local")) {
      this.localSocket = null;
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
    } else if (tags.includes("logs")) {
      this.logSubscribers.delete(ws);
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }
}
