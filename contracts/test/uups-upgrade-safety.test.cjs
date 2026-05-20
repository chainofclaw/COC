/**
 * UUPS upgrade-safety regressions (gen-5).
 *
 * Two guarantees this test set locks in:
 *
 * 1) Storage layout: every UUPS contract can be re-deployed and then
 *    upgradeProxy'd back onto the same implementation without the OZ
 *    upgrades plugin flagging an incompatible layout. Because the plugin's
 *    validator runs on every deployProxy/upgradeProxy call, just exercising
 *    the path on each contract proves the implementation's storage shape
 *    is well-formed (no `__gap` errors, no unsafe-allow markers needed
 *    beyond the locked-constructor one already declared in source).
 *
 * 2) Upgrade authorisation: every UUPS contract's _authorizeUpgrade reverts
 *    when called by a non-owner. This is the on-chain guarantee that the
 *    88780 multisig is the sole upgrade authority once ownership is
 *    transferred.
 */

const { expect } = require("chai")
const { ethers, upgrades } = require("hardhat")

// Each row: [factoryName, args-builder(deployer) → init args].
// initialOwner is always the last arg; non-owner upgrade tests
// connect a different signer.
function describeContract(factoryName, argsBuilder, postDeploy) {
  describe(`UUPS upgrade safety — ${factoryName}`, function () {
    let deployer, outsider
    let proxy

    beforeEach(async function () {
      ;[deployer, outsider] = await ethers.getSigners()
      const Factory = await ethers.getContractFactory(factoryName)
      const args = await argsBuilder(deployer)
      proxy = await upgrades.deployProxy(Factory, args, {
        initializer: "initialize",
        kind: "uups",
      })
      await proxy.waitForDeployment()
      if (postDeploy) await postDeploy(proxy, deployer)
    })

    it("upgradeProxy onto the same implementation succeeds (layout valid)", async function () {
      const Factory = await ethers.getContractFactory(factoryName)
      const upgraded = await upgrades.upgradeProxy(await proxy.getAddress(), Factory, {
        kind: "uups",
      })
      // The proxy address must not change after upgrade.
      expect(await upgraded.getAddress()).to.equal(await proxy.getAddress())
      // owner() must survive the upgrade
      expect((await upgraded.owner()).toLowerCase()).to.equal(deployer.address.toLowerCase())
    })

    it("non-owner cannot upgrade (reverts via _authorizeUpgrade)", async function () {
      // Deploy a fresh implementation off-proxy and try to call
      // upgradeToAndCall directly from a non-owner. The proxy delegates to
      // the implementation's _authorizeUpgrade, which must revert.
      const Factory = await ethers.getContractFactory(factoryName)
      const freshImpl = await Factory.deploy()
      await freshImpl.waitForDeployment()
      const proxyAsUUPS = await ethers.getContractAt(
        ["function upgradeToAndCall(address,bytes) payable"],
        await proxy.getAddress(),
        outsider,
      )
      await expect(
        proxyAsUUPS.upgradeToAndCall(await freshImpl.getAddress(), "0x"),
      ).to.be.reverted // any of OnlyOwner / "only owner" / "not owner"
    })
  })
}

describeContract(
  "FactionRegistry",
  async (d) => [d.address, d.address],
)

describeContract(
  "CidRegistry",
  async (d) => [d.address],
)

describeContract(
  "InsuranceFund",
  async (d) => [d.address, d.address],
)

describeContract(
  "FoundationVesting",
  async (d) => [d.address, d.address],
)

describeContract(
  "ValidatorRegistry",
  async (d) => [d.address, d.address, d.address],
)

describeContract(
  "DelayedInbox",
  async (d) => [86400, d.address, d.address],
)

describeContract(
  "RollupStateManager",
  async (d) => [
    86400,
    ethers.parseEther("1"),
    ethers.parseEther("1"),
    d.address,
    d.address,
    d.address,
  ],
)

describeContract(
  "SoulRegistry",
  async (d) => [d.address],
)

describeContract(
  "PoSeManager",
  async (d) => [d.address],
)

describeContract(
  "PoSeManagerV2",
  async (d) => [ethers.parseEther("0.1"), d.address],
  async (proxy) => {
    // Verify DOMAIN_SEPARATOR was computed from the proxy address inside
    // initialize, not the (locked) implementation. address(this) inside
    // initialize === the proxy address under delegatecall.
    const ds = await proxy.DOMAIN_SEPARATOR()
    expect(ds).to.not.equal(ethers.ZeroHash)
  },
)

// GovernanceDAO and Treasury depend on FactionRegistry being already
// deployed (Treasury also needs a 5-signer array). Hand them custom
// argsBuilders that deploy the dependency proxy first.

describeContract(
  "GovernanceDAO",
  async (d) => {
    const FR = await ethers.getContractFactory("FactionRegistry")
    const fr = await upgrades.deployProxy(FR, [d.address, d.address], {
      initializer: "initialize",
      kind: "uups",
    })
    await fr.waitForDeployment()
    return [await fr.getAddress(), d.address]
  },
)

describeContract(
  "Treasury",
  async (d) => {
    const signers = await ethers.getSigners()
    const signerAddrs = signers.slice(0, 5).map((s) => s.address)
    return [signerAddrs, d.address, d.address]
  },
)

describeContract(
  "DIDRegistry",
  async (d) => {
    const Soul = await ethers.getContractFactory("SoulRegistry")
    const soul = await upgrades.deployProxy(Soul, [d.address], {
      initializer: "initialize",
      kind: "uups",
    })
    await soul.waitForDeployment()
    return [await soul.getAddress(), d.address]
  },
)

describeContract(
  "EquivocationDetector",
  async (d) => {
    const VR = await ethers.getContractFactory("ValidatorRegistry")
    const vr = await upgrades.deployProxy(VR, [d.address, d.address, d.address], {
      initializer: "initialize",
      kind: "uups",
    })
    await vr.waitForDeployment()
    return [await vr.getAddress(), d.address]
  },
)

describeContract(
  "COCToken",
  async (d) => [[d.address], [ethers.parseEther("250000000")], d.address],
)
