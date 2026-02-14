import { NodeOpsPolicyEngine, NodeOpsActionType, type NodeOpsAction, type NodeOpsEngineState } from "./policy-engine.ts"
import type { NodeHealthSnapshot, NodeOpsPolicy } from "./policy-types.ts"

export interface NodeOpsAdapter {
  restartProcess(): Promise<void>
  reconnectPeers(targetPeerCount: number): Promise<void>
  switchTransport(prefer: "quic" | "tcp"): Promise<void>
  setRpcRateLimit(rps: number): Promise<void>
  alert(message: string): Promise<void>
  scheduleKeyRotation(): Promise<void>
}

export class NodeOpsHooks {
  private readonly engine: NodeOpsPolicyEngine
  private readonly adapter: NodeOpsAdapter
  private state: NodeOpsEngineState

  constructor(policy: NodeOpsPolicy, adapter: NodeOpsAdapter, initialState: NodeOpsEngineState = {}) {
    this.engine = new NodeOpsPolicyEngine(policy)
    this.adapter = adapter
    this.state = initialState
  }

  async tick(snapshot: NodeHealthSnapshot): Promise<NodeOpsAction[]> {
    const actions = this.engine.evaluate(snapshot, this.state)
    for (const action of actions) {
      await this.apply(action, snapshot.nowMs)
    }
    return actions
  }

  private async apply(action: NodeOpsAction, nowMs: bigint): Promise<void> {
    switch (action.type) {
      case NodeOpsActionType.RestartProcess:
        await this.adapter.restartProcess()
        this.state.lastRestartAtMs = nowMs
        return
      case NodeOpsActionType.ReconnectPeers:
        await this.adapter.reconnectPeers(Number(action.params?.targetPeerCount ?? 0))
        return
      case NodeOpsActionType.SwitchTransport:
        await this.adapter.switchTransport("quic")
        return
      case NodeOpsActionType.TightenRateLimit:
        await this.adapter.setRpcRateLimit(Number(action.params?.rpcRateLimitRps ?? 1))
        return
      case NodeOpsActionType.ScheduleKeyRotation:
        await this.adapter.scheduleKeyRotation()
        this.state.lastKeyRotationAtMs = nowMs
        return
      case NodeOpsActionType.RaiseAlert:
        await this.adapter.alert(action.reason)
        return
      default:
        await this.adapter.alert(`unhandled action: ${(action as NodeOpsAction).type}`)
    }
  }
}
