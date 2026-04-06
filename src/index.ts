// Relay Worker — 中继服务器入口
// 路由:
//   GET    /                                — 健康检查
//   POST   /tunnel                          — 创建 tunnel
//   GET    /tunnel/:id/connect              — 本地 WebSocket 连接入口
//   GET    /tunnel/:id/logs                 — 日志订阅 WebSocket
//   GET    /tunnel/:id/status               — 检查 tunnel 状态
//   ANY    /tunnel/:id/**                   — 转发请求到本地
//   POST   /registry/register               — 注册 agent
//   POST   /registry/unregister             — 注销 agent
//   POST   /registry/heartbeat              — 心跳
//   GET    /registry/agents                 — 列出在线 agents
//   ANY    /agent/:agentId/**               — 通过 agentId 路由到对应 tunnel

export { Tunnel } from "./tunnel";
export { Registry } from "./registry";

interface Env {
  TUNNEL: DurableObjectNamespace;
  REGISTRY: DurableObjectNamespace;
  AUTH_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight — no auth needed
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    // Health check — no auth needed
    if (path === "/" || path === "/health") {
      return Response.json({ status: "ok", service: "relay" }, { headers: corsHeaders() });
    }

    // Everything else requires auth
    if (!checkAuth(request, env)) {
      return Response.json(
        { error: "Unauthorized", hint: "Set Authorization: Bearer <token>" },
        { status: 401, headers: corsHeaders() }
      );
    }

    // Registry routes
    if (path.startsWith("/registry/")) {
      return forwardToRegistry(request, env, path);
    }

    // Agent route: /agent/:agentId/... → resolve to tunnel, then forward
    const agentMatch = path.match(/^\/agent\/([^/]+)(\/.*)?$/);
    if (agentMatch) {
      return handleAgentRoute(request, env, agentMatch[1], agentMatch[2] || "/");
    }

    // Create tunnel
    if (path === "/tunnel" && request.method === "POST") {
      return handleCreateTunnel(request, env);
    }

    // Direct tunnel route: /tunnel/:id/...
    const tunnelMatch = path.match(/^\/tunnel\/([^/]+)(\/.*)?$/);
    if (tunnelMatch) {
      return forwardToTunnel(request, env, tunnelMatch[1], tunnelMatch[2] || "/");
    }

    return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders() });
  },
};

function checkAuth(request: Request, env: Env): boolean {
  if (!env.AUTH_TOKEN) return true; // No token configured = open (dev mode)

  const auth = request.headers.get("Authorization");
  if (!auth) {
    // Also check query param for WebSocket (browsers can't set headers on WS)
    const url = new URL(request.url);
    const token = url.searchParams.get("token");
    return token === env.AUTH_TOKEN;
  }

  return auth === `Bearer ${env.AUTH_TOKEN}`;
}

function getRegistryStub(env: Env): DurableObjectStub {
  const id = env.REGISTRY.idFromName("global");
  return env.REGISTRY.get(id);
}

async function forwardToRegistry(request: Request, env: Env, path: string): Promise<Response> {
  const stub = getRegistryStub(env);
  const subPath = path.replace("/registry", "");
  const doUrl = new URL(request.url);
  doUrl.pathname = subPath || "/";
  const resp = await stub.fetch(new Request(doUrl.toString(), request));
  return addCors(resp);
}

async function handleAgentRoute(
  request: Request,
  env: Env,
  agentId: string,
  subPath: string
): Promise<Response> {
  // Resolve agentId to tunnelId via registry
  const stub = getRegistryStub(env);
  const resolveUrl = new URL(request.url);
  resolveUrl.pathname = `/resolve/${agentId}`;
  const resolveResp = await stub.fetch(new Request(resolveUrl.toString()));

  if (!resolveResp.ok) {
    return Response.json(
      { error: "Agent not found", agentId, hint: "Agent may be offline" },
      { status: 404, headers: corsHeaders() }
    );
  }

  const { tunnelId } = await resolveResp.json() as { tunnelId: string };
  return forwardToTunnel(request, env, tunnelId, subPath);
}

async function forwardToTunnel(
  request: Request,
  env: Env,
  tunnelId: string,
  subPath: string
): Promise<Response> {
  const doId = env.TUNNEL.idFromName(tunnelId);
  const stub = env.TUNNEL.get(doId);
  const doUrl = new URL(request.url);
  doUrl.pathname = subPath;
  const resp = await stub.fetch(new Request(doUrl.toString(), request));

  if (resp.webSocket) return resp;
  return addCors(resp);
}

async function handleCreateTunnel(request: Request, env: Env): Promise<Response> {
  let tunnelId: string;
  try {
    const body = await request.json() as any;
    tunnelId = body?.id || crypto.randomUUID().slice(0, 8);
  } catch {
    tunnelId = crypto.randomUUID().slice(0, 8);
  }

  const doId = env.TUNNEL.idFromName(tunnelId);
  const stub = env.TUNNEL.get(doId);
  const statusUrl = new URL(request.url);
  statusUrl.pathname = "/status";
  const status = await stub.fetch(new Request(statusUrl.toString()));
  const statusData = await status.json() as any;

  const baseUrl = new URL(request.url).origin;

  return Response.json({
    tunnelId,
    connected: statusData.connected,
    endpoints: {
      connect: `${baseUrl}/tunnel/${tunnelId}/connect`,
      logs: `${baseUrl}/tunnel/${tunnelId}/logs`,
      status: `${baseUrl}/tunnel/${tunnelId}/status`,
      proxy: `${baseUrl}/tunnel/${tunnelId}/`,
      agent: `${baseUrl}/agent/{agentId}/`,
    },
  }, { headers: corsHeaders() });
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function addCors(resp: Response): Response {
  const newResp = new Response(resp.body, resp);
  for (const [k, v] of Object.entries(corsHeaders())) {
    newResp.headers.set(k, v);
  }
  return newResp;
}
