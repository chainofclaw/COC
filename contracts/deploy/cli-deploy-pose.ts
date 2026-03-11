import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { deployPoSeManagerV2, type DeployResult, type DeployTarget } from "./deploy-pose.ts"

const DEFAULT_TARGET: DeployTarget = "l2-coc"
const DEFAULT_ARTIFACT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../artifacts/contracts-src/settlement/PoSeManagerV2.sol/PoSeManagerV2.json",
)

const HELP_TEXT = `Usage:
  node --experimental-strip-types deploy/cli-deploy-pose.ts [options]

Options:
  --target <target>           Deployment target preset (default: l2-coc)
  --artifact <path>           Contract artifact JSON path
  --private-key <hex>         Deployer private key; defaults to DEPLOYER_PRIVATE_KEY
  --json                      Print deployment result as JSON
  --help                      Show this help text
`

export interface DeployCliOptions {
  target: DeployTarget
  artifactPath: string
  privateKey?: string
  json: boolean
  help: boolean
}

export interface PoseArtifact {
  abi: object[]
  bytecode: string
}

export interface DeployCliIo {
  log(message: string): void
  error(message: string): void
}

export interface DeployCliDeps {
  loadArtifact(path: string): Promise<PoseArtifact>
  deploy(target: DeployTarget, abi: object[], bytecode: string, privateKey?: string): Promise<DeployResult>
}

const DEFAULT_IO: DeployCliIo = {
  log: (message) => console.log(message),
  error: (message) => console.error(message),
}

const DEFAULT_DEPS: DeployCliDeps = {
  loadArtifact: loadPoseArtifact,
  deploy: deployPoSeManagerV2,
}

export function parseDeployCliArgs(
  argv: string[],
  defaultArtifactPath = DEFAULT_ARTIFACT_PATH,
): DeployCliOptions {
  const options: DeployCliOptions = {
    target: DEFAULT_TARGET,
    artifactPath: defaultArtifactPath,
    json: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--json") {
      options.json = true
      continue
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true
      continue
    }

    const value = argv[i + 1]
    if (arg === "--target") {
      if (!value) throw new Error("--target requires a value")
      if (!isDeployTarget(value)) throw new Error(`unsupported deploy target: ${value}`)
      options.target = value
      i += 1
      continue
    }
    if (arg === "--artifact") {
      if (!value) throw new Error("--artifact requires a value")
      options.artifactPath = resolve(process.cwd(), value)
      i += 1
      continue
    }
    if (arg === "--private-key") {
      if (!value) throw new Error("--private-key requires a value")
      options.privateKey = value
      i += 1
      continue
    }

    throw new Error(`unknown argument: ${arg}`)
  }

  return options
}

export async function loadPoseArtifact(path: string): Promise<PoseArtifact> {
  const raw = await readFile(path, "utf-8")
  const parsed = JSON.parse(raw) as Partial<PoseArtifact>
  if (!Array.isArray(parsed.abi)) {
    throw new Error(`artifact missing abi array: ${path}`)
  }
  if (typeof parsed.bytecode !== "string" || parsed.bytecode.length === 0) {
    throw new Error(`artifact missing bytecode: ${path}`)
  }
  return {
    abi: parsed.abi,
    bytecode: parsed.bytecode,
  }
}

export async function runDeployCli(
  argv: string[],
  io: DeployCliIo = DEFAULT_IO,
  deps: DeployCliDeps = DEFAULT_DEPS,
): Promise<DeployResult | null> {
  const options = parseDeployCliArgs(argv)
  if (options.help) {
    io.log(HELP_TEXT.trimEnd())
    return null
  }

  const artifact = await deps.loadArtifact(options.artifactPath)
  const result = await deps.deploy(options.target, artifact.abi, artifact.bytecode, options.privateKey)

  if (options.json) {
    io.log(JSON.stringify({
      target: options.target,
      artifactPath: options.artifactPath,
      ...result,
    }, null, 2))
  } else {
    io.log(`deployed PoSeManagerV2 to ${result.contractAddress}`)
    io.log(`target: ${options.target}`)
    io.log(`chainId: ${result.chainId}`)
    io.log(`txHash: ${result.transactionHash}`)
    io.log(`blockNumber: ${result.blockNumber}`)
  }

  return result
}

function isDeployTarget(value: string): value is DeployTarget {
  return value === "l1-mainnet"
    || value === "l1-sepolia"
    || value === "l2-coc"
    || value === "l2-arbitrum"
    || value === "l2-optimism"
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDeployCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    DEFAULT_IO.error(message)
    process.exitCode = 1
  })
}
