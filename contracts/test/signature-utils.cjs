const { ethers } = require("hardhat")

const SECP256K1_N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141")

function malleateSignature(signature) {
  const parsed = ethers.Signature.from(signature)
  const highS = SECP256K1_N - BigInt(parsed.s)
  const highSHex = `0x${highS.toString(16).padStart(64, "0")}`
  const flippedV = parsed.v === 27 ? 28 : 27

  return ethers.concat([
    parsed.r,
    ethers.zeroPadValue(highSHex, 32),
    ethers.toBeHex(flippedV, 1),
  ])
}

module.exports = { malleateSignature }
