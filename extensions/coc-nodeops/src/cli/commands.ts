import { execSync } from "node:child_process"
import type { Command } from "commander"
import type { PluginLogger } from "openclaw/plugin-sdk"

import type { CocConfig } from "../config-schema.ts"
import type { NodeManager } from "../runtime/node-manager.ts"
import { runInitWizard } from "./init-wizard.ts"

export function registerCocCommands(
  program: Command,
  config: CocConfig,
  logger: PluginLogger,
  nodeManager: NodeManager,
): void {
  const coc = program.command("coc").description("Manage COC blockchain nodes")

  // --- coc init ---
  coc
    .command("init")
    .description("Initialize a new COC node")
    .option("-t, --type <type>", "Node type: validator|fullnode|archive|gateway|dev")
    .option("-n, --network <network>", "Network: testnet|mainnet|local|custom")
    .option("--name <name>", "Node name")
    .option("--data-dir <dir>", "Data directory")
    .option("--rpc-port <port>", "RPC port", Number)
    .action(async (opts) => {
      try {
        await runInitWizard(nodeManager, {
          type: opts.type,
          network: opts.network,
          name: opts.name,
          dataDir: opts.dataDir,
          rpcPort: opts.rpcPort,
        })
      } catch (error) {
        logger.error(`Init failed: ${String(error)}`)
        process.exit(1)
      }
    })

  // --- coc list ---
  coc
    .command("list")
    .description("List all managed node instances")
    .option("--json", "Output JSON")
    .action(async (opts) => {
      const nodes = nodeManager.listNodes()
      if (nodes.length === 0) {
        console.log('No nodes configured. Run "openclaw coc init" to create one.')
        return
      }

      if (opts.json) {
        console.log(JSON.stringify(nodes, null, 2))
        return
      }

      // Table header
      const header = padRow("NAME", "TYPE", "NETWORK", "SERVICES", "CREATED")
      console.log(header)
      console.log("-".repeat(header.length))
      for (const node of nodes) {
        console.log(
          padRow(
            node.name,
            node.type,
            node.network,
            node.services.join(","),
            node.createdAt.slice(0, 10),
          ),
        )
      }
    })

  // --- coc start [name] ---
  coc
    .command("start [name]")
    .description("Start a node (or all nodes)")
    .action(async (name?: string) => {
      try {
        if (name) {
          await nodeManager.startNode(name)
          console.log(`Node "${name}" started`)
        } else {
          const nodes = nodeManager.listNodes()
          if (nodes.length === 0) {
            console.log('No nodes configured. Run "openclaw coc init" first.')
            return
          }
          for (const node of nodes) {
            await nodeManager.startNode(node.name)
            console.log(`Node "${node.name}" started`)
          }
        }
      } catch (error) {
        logger.error(`Start failed: ${String(error)}`)
        process.exit(1)
      }
    })

  // --- coc stop [name] ---
  coc
    .command("stop [name]")
    .description("Stop a node (or all nodes)")
    .action(async (name?: string) => {
      try {
        if (name) {
          await nodeManager.stopNode(name)
          console.log(`Node "${name}" stopped`)
        } else {
          const nodes = nodeManager.listNodes()
          for (const node of [...nodes].reverse()) {
            await nodeManager.stopNode(node.name)
            console.log(`Node "${node.name}" stopped`)
          }
        }
      } catch (error) {
        logger.error(`Stop failed: ${String(error)}`)
        process.exit(1)
      }
    })

  // --- coc restart [name] ---
  coc
    .command("restart [name]")
    .description("Restart a node (or all nodes)")
    .action(async (name?: string) => {
      try {
        if (name) {
          await nodeManager.restartNode(name)
          console.log(`Node "${name}" restarted`)
        } else {
          const nodes = nodeManager.listNodes()
          for (const node of nodes) {
            await nodeManager.restartNode(node.name)
            console.log(`Node "${node.name}" restarted`)
          }
        }
      } catch (error) {
        logger.error(`Restart failed: ${String(error)}`)
        process.exit(1)
      }
    })

  // --- coc status [name] ---
  coc
    .command("status [name]")
    .description("Show node status (with RPC stats)")
    .option("--json", "Output JSON")
    .action(async (name: string | undefined, opts: { json?: boolean }) => {
      try {
        if (name) {
          const status = await nodeManager.getNodeStatus(name)
          if (opts.json) {
            console.log(JSON.stringify(status, null, 2))
            return
          }
          printNodeStatus(status)
        } else {
          const nodes = nodeManager.listNodes()
          if (nodes.length === 0) {
            console.log('No nodes configured. Run "openclaw coc init" first.')
            return
          }
          const statuses = await Promise.all(
            nodes.map((n) => nodeManager.getNodeStatus(n.name)),
          )
          if (opts.json) {
            console.log(JSON.stringify(statuses, null, 2))
            return
          }
          for (const status of statuses) {
            printNodeStatus(status)
            console.log()
          }
        }
      } catch (error) {
        logger.error(`Status failed: ${String(error)}`)
        process.exit(1)
      }
    })

  // --- coc remove <name> ---
  coc
    .command("remove <name>")
    .description("Remove a node instance")
    .option("--yes", "Skip confirmation")
    .option("--keep-data", "Keep data directory")
    .action(async (name: string, opts: { yes?: boolean; keepData?: boolean }) => {
      const node = nodeManager.getNode(name)
      if (!node) {
        console.error(`Node "${name}" not found`)
        process.exit(1)
      }

      if (!opts.yes) {
        // Simple stdin confirmation
        process.stdout.write(`Remove node "${name}"${opts.keepData ? "" : " and delete all data"}? [y/N] `)
        const answer = await readLine()
        if (answer.toLowerCase() !== "y") {
          console.log("Cancelled")
          return
        }
      }

      const deleted = await nodeManager.removeNode(name, !opts.keepData)
      if (deleted) {
        console.log(`Node "${name}" removed`)
      }
    })

  // --- coc config show [name] ---
  const configCmd = coc.command("config").description("Node configuration")

  configCmd
    .command("show [name]")
    .description("Show node configuration")
    .action(async (name?: string) => {
      try {
        if (!name) {
          const nodes = nodeManager.listNodes()
          if (nodes.length === 1) {
            name = nodes[0].name
          } else if (nodes.length === 0) {
            console.log("No nodes configured")
            return
          } else {
            console.log("Specify a node name. Available nodes:")
            for (const n of nodes) console.log(`  ${n.name}`)
            return
          }
        }
        const cfg = await nodeManager.getNodeConfig(name)
        console.log(JSON.stringify(cfg, null, 2))
      } catch (error) {
        logger.error(`Config show failed: ${String(error)}`)
        process.exit(1)
      }
    })

  configCmd
    .command("edit <name>")
    .description("Edit node configuration in $EDITOR")
    .action(async (name: string) => {
      const node = nodeManager.getNode(name)
      if (!node) {
        console.error(`Node "${name}" not found`)
        process.exit(1)
      }
      const editor = process.env.EDITOR || "vi"
      const configPath = `${node.dataDir}/node-config.json`
      try {
        execSync(`${editor} ${configPath}`, { stdio: "inherit" })
        console.log("Configuration saved")
      } catch {
        console.error("Editor exited with error")
      }
    })

  // --- coc logs <name> ---
  coc
    .command("logs <name>")
    .description("View node logs")
    .option("-f, --follow", "Follow log output")
    .option("--service <service>", "Service: node|agent|relayer", "node")
    .action(async (name: string, opts: { follow?: boolean; service?: string }) => {
      const node = nodeManager.getNode(name)
      if (!node) {
        console.error(`Node "${name}" not found`)
        process.exit(1)
      }
      const service = opts.service || "node"
      const logPath = `${node.dataDir}/coc-${service}.log`

      if (opts.follow) {
        try {
          execSync(`tail -f ${logPath}`, { stdio: "inherit" })
        } catch {
          // user Ctrl+C
        }
      } else {
        try {
          const { readFile } = await import("node:fs/promises")
          const content = await readFile(logPath, "utf-8")
          // Print last 100 lines
          const lines = content.split("\n")
          const tail = lines.slice(-100)
          console.log(tail.join("\n"))
        } catch {
          console.log(`No logs found at ${logPath}`)
        }
      }
    })
}

// --- Helpers ---

function padRow(...cols: string[]): string {
  const widths = [16, 12, 12, 20, 12]
  return cols.map((c, i) => c.padEnd(widths[i] ?? 16)).join(" ")
}

function printNodeStatus(status: {
  name: string
  running: boolean
  pid?: number
  blockHeight?: number
  peerCount?: number
  bftActive?: boolean
  services: Record<string, { running: boolean; pid?: number }>
}): void {
  const state = status.running ? "RUNNING" : "STOPPED"
  console.log(`${status.name}: ${state}`)
  if (status.pid) console.log(`  PID: ${status.pid}`)
  if (status.blockHeight !== undefined) console.log(`  Block: #${status.blockHeight}`)
  if (status.peerCount !== undefined) console.log(`  Peers: ${status.peerCount}`)
  if (status.bftActive !== undefined) console.log(`  BFT: ${status.bftActive ? "active" : "inactive"}`)
  for (const [svc, st] of Object.entries(status.services)) {
    console.log(`  ${svc}: ${st.running ? "running" : "stopped"}${st.pid ? ` (${st.pid})` : ""}`)
  }
}

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin
    stdin.setEncoding("utf-8")
    stdin.resume()
    stdin.once("data", (data) => {
      stdin.pause()
      resolve(String(data).trim())
    })
  })
}
