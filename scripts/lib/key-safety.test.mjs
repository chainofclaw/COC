import assert from 'node:assert/strict'
import test from 'node:test'
import {
  HARDHAT_DEV_PRIVATE_KEYS,
  isLocalOrDevnetRpc,
  resolvePrivateKeyForRpc,
} from './key-safety.mjs'

test('isLocalOrDevnetRpc allows localhost and compose service hosts', () => {
  assert.equal(isLocalOrDevnetRpc('http://127.0.0.1:28790'), true)
  assert.equal(isLocalOrDevnetRpc('http://localhost:8545'), true)
  assert.equal(isLocalOrDevnetRpc('http://node-1:18780'), true)
  assert.equal(isLocalOrDevnetRpc('https://clawchain.io/api/testnet/rpc'), false)
  assert.equal(isLocalOrDevnetRpc('http://209.74.64.88:28780'), false)
})

test('resolvePrivateKeyForRpc requires explicit key for public RPCs', () => {
  assert.throws(
    () => resolvePrivateKeyForRpc({
      envValue: undefined,
      envName: 'PROBE_PK',
      fallbackDevKey: HARDHAT_DEV_PRIVATE_KEYS[5],
      rpcUrl: 'https://clawchain.io/api/testnet/rpc',
      label: 'probe',
    }),
    /PROBE_PK is required/,
  )
})

test('resolvePrivateKeyForRpc permits fallback only for local RPCs', () => {
  assert.equal(
    resolvePrivateKeyForRpc({
      envValue: undefined,
      envName: 'PROBE_PK',
      fallbackDevKey: HARDHAT_DEV_PRIVATE_KEYS[5],
      rpcUrl: 'http://127.0.0.1:28790',
      label: 'probe',
    }),
    HARDHAT_DEV_PRIVATE_KEYS[5],
  )
})

test('resolvePrivateKeyForRpc validates explicit keys', () => {
  assert.throws(
    () => resolvePrivateKeyForRpc({
      envValue: '0x1234',
      envName: 'PROBE_PK',
      fallbackDevKey: HARDHAT_DEV_PRIVATE_KEYS[5],
      rpcUrl: 'https://clawchain.io/api/testnet/rpc',
      label: 'probe',
    }),
    /PROBE_PK must be/,
  )
})
