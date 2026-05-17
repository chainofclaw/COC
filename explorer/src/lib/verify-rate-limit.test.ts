import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getVerifyRateLimitKey, hashVerifyRateLimitSecret } from './verify-rate-limit.ts'

describe('verify API rate-limit keys', () => {
  it('does not include raw API keys in the bucket key', () => {
    const key = getVerifyRateLimitKey('203.0.113.7', 'secret-api-key')
    assert.equal(key.includes('secret-api-key'), false)
    assert.match(key, /^verify:203\.0\.113\.7:key:[0-9a-f]{64}$/)
  })

  it('uses an IP-only auth bucket for pre-auth failures', () => {
    assert.equal(getVerifyRateLimitKey('203.0.113.7', null, 'auth'), 'auth:203.0.113.7:anon')
  })

  it('hashes the same secret deterministically', () => {
    assert.equal(hashVerifyRateLimitSecret('a'), hashVerifyRateLimitSecret('a'))
    assert.notEqual(hashVerifyRateLimitSecret('a'), hashVerifyRateLimitSecret('b'))
  })
})
