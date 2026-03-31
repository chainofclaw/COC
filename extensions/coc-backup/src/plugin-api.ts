import type { Command } from "commander"

export interface PluginLogger {
  info(msg: string): void
  error(msg: string): void
  warn(msg: string): void
}

export interface PluginToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute(params: any): Promise<any>
}

export interface OpenClawPluginApi {
  logger: PluginLogger
  pluginConfig?: unknown
  registerCli(
    handler: (ctx: { program: Command }) => Promise<void> | void,
    options: { commands: string[] },
  ): void
  registerTool(definition: PluginToolDefinition): void
  registerHook?(
    name: string,
    handler: () => Promise<void> | void,
  ): void
}
