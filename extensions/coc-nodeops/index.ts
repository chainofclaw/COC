import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import { CocConfigSchema } from "./src/config-schema.ts"
import { registerCocCommands } from "./src/cli/commands.ts"
import { NodeManager } from "./src/runtime/node-manager.ts"

export function activate(api: OpenClawPluginApi) {
  const logger = api.logger
  logger.info("COC node ops extension loading...")

  let config
  try {
    config = CocConfigSchema.parse(api.pluginConfig ?? {})
  } catch (error) {
    logger.error(`COC config parse failed: ${String(error)}`)
    return
  }

  const nodeManager = new NodeManager(config.dataDir, logger)

  api.registerCli(
    async ({ program }) => {
      await nodeManager.init()
      registerCocCommands(program, config, logger, nodeManager)
      logger.info("COC CLI commands registered")
    },
    { commands: ["coc"] },
  )

  logger.info("COC extension loaded")
}
