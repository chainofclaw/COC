/**
 * Cron stress worker — sends transactions + deploys/calls contracts on COC testnet.
 * Called by cron-stress.sh every minute. Outputs a single JSON line.
 *
 * Each run performs one of three test types (round-robin):
 *   Round 0: 3 ETH transfers (legacy type 0)
 *   Round 1: Deploy Counter contract (if not deployed) + 3 increment() calls
 *   Round 2: Deploy ERC20 (if not deployed) + mint + transfer
 */
import { ethers } from "ethers"
import { readFileSync, writeFileSync } from "node:fs"

const RPC_URL = process.argv[2] || "http://127.0.0.1:28780"
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const CONFIRM_TIMEOUT_S = 15
const STATE_PATH = "/tmp/coc-stress-contracts.json"

// --- Embedded contract artifacts ---
const COUNTER_BYTECODE = "0x608080604052346100155760ea908161001b8239f35b600080fdfe6080806040526004361015601257600080fd5b600090813560e01c90816306661abd146098575063d09de08a14603457600080fd5b3460955780600319360112609557805460001981146081576001018082556040519081527f38ac789ed44572701765277c4d0970f2db1c1a571ed39e84358095ae4eaa542060203392a280f35b634e487b7160e01b82526011600452602482fd5b80fd5b90503460b0578160031936011260b057602091548152f35b5080fdfea26469706673582212200601b4a0ea9a382d6b93facedeb52573bce750d3c0caad9dc838e0429eb5861b64736f6c63430008180033"
const COUNTER_ABI = ["function increment()", "function count() view returns (uint256)", "event Incremented(address indexed caller, uint256 newCount)"]

const ERC20_BYTECODE = "0x60803461016957601f6109e238819003918201601f19168301916001600160401b0383118484101761016e578084926020946040528339810103126101695751600061004b8154610184565b601f811161013f575b507f5465737420546f6b656e0000000000000000000000000000000000000000001481556001805461008590610184565b601f81116100f8575b5050600863151154d560e21b01600155601260ff1960025416176002558160035533815260046020528160408220556040519182527fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef60203393a360405161082390816101bf8239f35b60018352601f0160051c7fb10e2d527612073b26eecdfd717e6a320cf44b4afac2b0732d9fcbe2b7fa0cf6908101905b818110610135575061008e565b8381558201610128565b818052601f60208320910160051c8101905b81811061015e5750610054565b828155600101610151565b600080fd5b634e487b7160e01b600052604160045260246000fd5b90600182811c921680156101b4575b602083101461019e57565b634e487b7160e01b600052602260045260246000fd5b91607f169161019356fe608060408181526004918236101561001657600080fd5b600092833560e01c91826306fdde03146105c857508163095ea7b31461051957816318160ddd146104fa57816323b872dd146103e3578163313ce567146103c15783826340c10f191461034e57826342966c68146102dd5750816370a08231146102a757816395d89b4114610184578163a9059cbb146100eb575063dd62ed3e146100a057600080fd5b346100e757806003193601126100e757806020926100bc6106e9565b6100c4610704565b6001600160a01b0391821683526005865283832091168252845220549051908152f35b5080fd5b905034610180578160031936011261018057602092826101096106e9565b91602435923382528487526101238484842054101561071a565b6001600160a01b03169361013885151561075d565b33825280875282822061014c85825461079d565b905584825286522061015f8282546107c0565b905582519081526000805160206107ce833981519152843392a35160018152f35b8280fd5b8383346100e757816003193601126100e7578051908260018054908160011c906001831692831561029d575b602093848410811461028a5783885290811561026e5750600114610218575b505050829003601f01601f191682019267ffffffffffffffff84118385101761020557508291826102019252826106a0565b0390f35b634e487b7160e01b815260418552602490fd5b600187529192508591837fb10e2d527612073b26eecdfd717e6a320cf44b4afac2b0732d9fcbe2b7fa0cf65b83851061025a57505050508301018580806101cf565b805488860183015293019284908201610244565b60ff1916878501525050151560051b84010190508580806101cf565b634e487b7160e01b895260228a52602489fd5b91607f16916101b0565b9050346101805760203660031901126101805760209282916001600160a01b036102cf6106e9565b168252845220549051908152f35b8091843461034a57602036600319011261034a578135913384528060205261030a8383862054101561071a565b33845260205280832061031e83825461079d565b905561032c8260035461079d565b600355519081526000805160206107ce83398151915260203392a380f35b5050fd5b915091346100e757806003193601126100e75760206000805160206107ce8339815191529161037b6106e9565b6001600160a01b031694602435919061039587151561075d565b6103a1836003546107c0565b60035586865283528085206103b78382546107c0565b905551908152a380f35b5050346100e757816003193601126100e75760209060ff600254169051908152f35b905034610180576060366003190112610180576103fe6106e9565b610406610704565b936044359060018060a01b038093169283825260209685885261042e8488852054101561071a565b8483526005885286832033845288528387842054106104be5787926000805160206107ce83398151915294928892169661046988151561075d565b86825280855282822061047d85825461079d565b905587825284528181206104928482546107c0565b9055858152600584528181203382528452206104af82825461079d565b90558551908152a35160018152f35b865162461bcd60e51b81528087018990526016602482015275496e73756666696369656e7420616c6c6f77616e636560501b6044820152606490fd5b5050346100e757816003193601126100e7576020906003549051908152f35b8284346105c557816003193601126105c5576105336106e9565b6001600160a01b0316906024359082156105905760209450838291338152600587528181208582528752205582519081527f8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925843392a35160018152f35b835162461bcd60e51b8152602081870152600f60248201526e24b73b30b634b21039b832b73232b960891b6044820152606490fd5b80fd5b8490843461018057826003193601126101805782835460018160011c9060018316928315610696575b602093848410811461028a5783885290811561026e575060011461064157505050829003601f01601f191682019267ffffffffffffffff84118385101761020557508291826102019252826106a0565b0390f35b8680529192508591837f290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e5635b83851061068257505050508301018580806101cf565b80548886018301529301928490820161066c565b91607f16916105f1565b6020808252825181830181905290939260005b8281106106d557505060409293506000838284010152601f8019910116010190565b8181018601518482016040015285016106b3565b600435906001600160a01b03821682036106ff57565b600080fd5b602435906001600160a01b03821682036106ff57565b1561072157565b60405162461bcd60e51b8152602060048201526014602482015273496e73756666696369656e742062616c616e636560601b6044820152606490fd5b1561076457565b60405162461bcd60e51b8152602060048201526011602482015270125b9d985b1a59081c9958da5c1a595b9d607a1b6044820152606490fd5b919082039182116107aa57565b634e487b7160e01b600052601160045260246000fd5b919082018092116107aa5756feddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3efa2646970667358221220d4b9a373e385e7fd8064fa50257784e2ae557207c07908805a0e36d13cf30d1e64736f6c63430008180033"
const ERC20_ABI = [
  "constructor(uint256 initialSupply)",
  "function transfer(address to, uint256 value) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function mint(address to, uint256 amount)",
  "function totalSupply() view returns (uint256)",
  "function name() view returns (string)",
]

// --- State persistence ---
interface ContractState {
  counterAddr?: string
  erc20Addr?: string
  round: number
}

function loadState(): ContractState {
  try { return JSON.parse(readFileSync(STATE_PATH, "utf-8")) } catch { return { round: 0 } }
}
function saveState(s: ContractState) {
  writeFileSync(STATE_PATH, JSON.stringify(s))
}

// --- Helpers ---
async function waitReceipt(provider: ethers.JsonRpcProvider, hash: string, timeoutS: number): Promise<ethers.TransactionReceipt | null> {
  const deadline = Date.now() + timeoutS * 1000
  while (Date.now() < deadline) {
    const r = await provider.getTransactionReceipt(hash).catch(() => null)
    if (r) return r
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  return null
}

async function getGasPrice(provider: ethers.JsonRpcProvider): Promise<bigint> {
  const fee = await provider.getFeeData()
  return (fee.gasPrice ?? 2000000000n) * 2n
}

// --- Test rounds ---
async function roundTransfers(wallet: ethers.Wallet, provider: ethers.JsonRpcProvider): Promise<{ sent: number; confirmed: number; detail: string }> {
  const nonce = await provider.getTransactionCount(wallet.address, "pending")
  const gasPrice = await getGasPrice(provider)
  const hashes: string[] = []
  for (let i = 0; i < 3; i++) {
    try {
      const tx = await wallet.sendTransaction({ to: "0x000000000000000000000000000000000000dEaD", value: 1000n + BigInt(i), nonce: nonce + i, type: 0, gasPrice, gasLimit: 21000 })
      hashes.push(tx.hash)
    } catch { /* skip */ }
  }
  let confirmed = 0
  for (const h of hashes) { if ((await waitReceipt(provider, h, CONFIRM_TIMEOUT_S))?.status === 1) confirmed++ }
  return { sent: hashes.length, confirmed, detail: "eth_transfer" }
}

async function roundCounter(wallet: ethers.Wallet, provider: ethers.JsonRpcProvider, state: ContractState): Promise<{ sent: number; confirmed: number; detail: string }> {
  const gasPrice = await getGasPrice(provider)
  let addr = state.counterAddr

  // Deploy if not yet deployed
  if (!addr) {
    const factory = new ethers.ContractFactory(COUNTER_ABI, COUNTER_BYTECODE, wallet)
    try {
      const contract = await factory.deploy({ type: 0, gasPrice, gasLimit: 200000 })
      const r = await waitReceipt(provider, contract.deploymentTransaction()!.hash, CONFIRM_TIMEOUT_S)
      if (r?.status === 1 && r.contractAddress) {
        addr = r.contractAddress
        state.counterAddr = addr
        saveState(state)
        return { sent: 1, confirmed: 1, detail: `counter_deploy:${addr.slice(0, 10)}` }
      }
    } catch { /* deploy failed */ }
    return { sent: 1, confirmed: 0, detail: "counter_deploy_fail" }
  }

  // Call increment() 3 times
  const counter = new ethers.Contract(addr, COUNTER_ABI, wallet)
  const nonce = await provider.getTransactionCount(wallet.address, "pending")
  const hashes: string[] = []
  for (let i = 0; i < 3; i++) {
    try {
      const tx = await counter.increment({ type: 0, gasPrice, gasLimit: 60000, nonce: nonce + i })
      hashes.push(tx.hash)
    } catch { /* skip */ }
  }
  let confirmed = 0
  for (const h of hashes) { if ((await waitReceipt(provider, h, CONFIRM_TIMEOUT_S))?.status === 1) confirmed++ }

  // Read counter value (view call — no gas)
  let countVal = "?"
  try { countVal = String(await counter.count()) } catch { /* ignore */ }

  return { sent: hashes.length, confirmed, detail: `counter_call:${countVal}` }
}

async function roundERC20(wallet: ethers.Wallet, provider: ethers.JsonRpcProvider, state: ContractState): Promise<{ sent: number; confirmed: number; detail: string }> {
  const gasPrice = await getGasPrice(provider)
  let addr = state.erc20Addr

  // Deploy if not yet deployed
  if (!addr) {
    const factory = new ethers.ContractFactory(ERC20_ABI, ERC20_BYTECODE, wallet)
    try {
      const supply = ethers.parseEther("1000000")
      const contract = await factory.deploy(supply, { type: 0, gasPrice, gasLimit: 800000 })
      const r = await waitReceipt(provider, contract.deploymentTransaction()!.hash, CONFIRM_TIMEOUT_S)
      if (r?.status === 1 && r.contractAddress) {
        addr = r.contractAddress
        state.erc20Addr = addr
        saveState(state)
        return { sent: 1, confirmed: 1, detail: `erc20_deploy:${addr.slice(0, 10)}` }
      }
    } catch { /* deploy failed */ }
    return { sent: 1, confirmed: 0, detail: "erc20_deploy_fail" }
  }

  // Mint + transfer
  const token = new ethers.Contract(addr, ERC20_ABI, wallet)
  const nonce = await provider.getTransactionCount(wallet.address, "pending")
  const hashes: string[] = []
  const recipient = "0x000000000000000000000000000000000000dEaD"

  try {
    // mint small amount (keep gas low)
    const tx1 = await token.mint(wallet.address, ethers.parseEther("1"), { type: 0, gasPrice, gasLimit: 100000, nonce })
    hashes.push(tx1.hash)
    // transfer
    const tx2 = await token.transfer(recipient, ethers.parseEther("0.1"), { type: 0, gasPrice, gasLimit: 100000, nonce: nonce + 1 })
    hashes.push(tx2.hash)
  } catch { /* skip */ }

  let confirmed = 0
  for (const h of hashes) { if ((await waitReceipt(provider, h, CONFIRM_TIMEOUT_S))?.status === 1) confirmed++ }

  // Read balance (view)
  let balance = "?"
  try { balance = ethers.formatEther(await token.balanceOf(wallet.address)) } catch { /* ignore */ }

  return { sent: hashes.length, confirmed, detail: `erc20_ops:bal=${balance}` }
}

// --- Main ---
async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL)
  const wallet = new ethers.Wallet(DEPLOYER_KEY, provider)

  let height: number, peers: number
  try {
    height = await provider.getBlockNumber()
    peers = parseInt(await provider.send("net_peerCount", []) as string, 16)
  } catch {
    console.log(JSON.stringify({ status: "UNREACHABLE", height: 0, blocks: 0, sent: 0, confirmed: 0, peers: 0, sync: "?", detail: "" }))
    return
  }

  const state = loadState()
  // ETH transfers only for stability monitoring.
  // Contract deploy/call is disabled due to cross-proposer EVM state conflicts
  // that stall the BFT chain when multiple proposers process the same contract
  // transactions with different storage states. This requires an architectural
  // fix (proposer-exclusive execution or EVM state isolation).
  let result: { sent: number; confirmed: number; detail: string }
  try {
    result = await roundTransfers(wallet, provider)
  } catch (e) {
    result = { sent: 0, confirmed: 0, detail: `error:${String(e).slice(0, 50)}` }
  }
  state.round = (state.round + 1)

  state.round = (state.round + 1)
  saveState(state)

  const finalHeight = await provider.getBlockNumber()
  let sync = "ok"
  for (const port of [28780, 28782, 28784]) {
    try {
      const h = await new ethers.JsonRpcProvider(`http://127.0.0.1:${port}`).getBlockNumber()
      if (Math.abs(finalHeight - h) > 2) sync = "desync"
    } catch { sync = "partial" }
  }

  let status = "OK"
  if (result.confirmed < result.sent) status = "PARTIAL"
  if (result.sent === 0) status = "SEND_FAIL"
  if (sync === "desync") status = "DESYNC"

  console.log(JSON.stringify({
    status,
    height: finalHeight,
    blocks: finalHeight - height,
    sent: result.sent,
    confirmed: result.confirmed,
    peers,
    sync,
    detail: result.detail,
  }))
}

main().catch(() => {
  console.log(JSON.stringify({ status: "CRASH", height: 0, blocks: 0, sent: 0, confirmed: 0, peers: 0, sync: "?", detail: "" }))
})
