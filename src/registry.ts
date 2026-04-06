// Registry Durable Object
// 注册中心：追踪所有在线 agent 连接

export interface AgentInfo {
  agentId: string;        // agent 唯一标识（如 "dolphin-mac", "ci-runner"）
  tunnelId: string;       // 对应的 tunnel ID
  connectedAt: string;    // 连接时间
  lastSeen: string;       // 最后心跳时间
  metadata?: Record<string, string>;  // 附加信息（如 hostname, platform）
}

const STALE_THRESHOLD = 60_000;  // 60s 无心跳视为离线
const ALARM_INTERVAL = 30_000;   // 30s 定时清理

export class Registry implements DurableObject {
  private state: DurableObjectState;
  private agents: Map<string, AgentInfo> = new Map();

  constructor(state: DurableObjectState) {
    this.state = state;
    state.blockConcurrencyWhile(async () => {
      const stored = await state.storage.get<Map<string, AgentInfo>>("agents");
      if (stored) this.agents = stored;
      // 启动定时清理
      const alarm = await state.storage.getAlarm();
      if (!alarm) {
        await state.storage.setAlarm(Date.now() + ALARM_INTERVAL);
      }
    });
  }

  // 定时清理过期 agent
  async alarm(): Promise<void> {
    this.cleanStale();
    await this.state.storage.put("agents", this.agents);
    // 只要还有 agent 就继续定时
    if (this.agents.size > 0) {
      await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL);
    }
  }

  private cleanStale(): boolean {
    const now = Date.now();
    let cleaned = false;
    for (const [id, agent] of this.agents) {
      if (now - new Date(agent.lastSeen).getTime() > STALE_THRESHOLD) {
        this.agents.delete(id);
        cleaned = true;
      }
    }
    return cleaned;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Register an agent
    if (path === "/register" && request.method === "POST") {
      const info = await request.json() as AgentInfo;
      if (!info.agentId || !info.tunnelId) {
        return Response.json({ error: "agentId and tunnelId required" }, { status: 400 });
      }
      info.connectedAt = info.connectedAt || new Date().toISOString();
      info.lastSeen = new Date().toISOString();
      this.agents.set(info.agentId, info);
      await this.state.storage.put("agents", this.agents);
      // 确保 alarm 在运行
      const alarm = await this.state.storage.getAlarm();
      if (!alarm) {
        await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL);
      }
      return Response.json({ ok: true, agent: info });
    }

    // Unregister an agent
    if (path === "/unregister" && request.method === "POST") {
      const body = await request.json() as { agentId: string };
      this.agents.delete(body.agentId);
      await this.state.storage.put("agents", this.agents);
      return Response.json({ ok: true });
    }

    // Heartbeat
    if (path === "/heartbeat" && request.method === "POST") {
      const body = await request.json() as { agentId: string };
      const agent = this.agents.get(body.agentId);
      if (agent) {
        agent.lastSeen = new Date().toISOString();
        this.agents.set(body.agentId, agent);
        await this.state.storage.put("agents", this.agents);
      }
      return Response.json({ ok: true });
    }

    // List all online agents
    if (path === "/agents") {
      this.cleanStale();
      await this.state.storage.put("agents", this.agents);
      return Response.json({
        agents: Array.from(this.agents.values()),
        count: this.agents.size,
      });
    }

    // Resolve agent to tunnel
    if (path.startsWith("/resolve/")) {
      const agentId = path.slice("/resolve/".length);
      const agent = this.agents.get(agentId);
      if (!agent) {
        return Response.json({ error: "Agent not found", agentId }, { status: 404 });
      }
      // 检查是否过期
      if (Date.now() - new Date(agent.lastSeen).getTime() > STALE_THRESHOLD) {
        this.agents.delete(agentId);
        await this.state.storage.put("agents", this.agents);
        return Response.json({ error: "Agent offline", agentId }, { status: 404 });
      }
      return Response.json({ agentId, tunnelId: agent.tunnelId });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }
}
