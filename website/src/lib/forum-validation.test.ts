import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const {
  getRequiredString,
  isHexAddress,
  parsePositiveInt,
  parsePositiveIntParam,
} = await import('./forum-validation.' + 'ts')

describe('forum input validation helpers', () => {
  it('trims and rejects empty or non-string values', () => {
    assert.equal(getRequiredString('  hello  '), 'hello')
    assert.equal(getRequiredString('   '), null)
    assert.equal(getRequiredString(123), null)
  })

  it('validates EVM hex addresses', () => {
    assert.equal(isHexAddress('0x0000000000000000000000000000000000000001'), true)
    assert.equal(isHexAddress('0x1234'), false)
    assert.equal(isHexAddress(1), false)
  })

  it('parses positive integer IDs and clamps query limits', () => {
    assert.equal(parsePositiveInt('42'), 42)
    assert.equal(parsePositiveInt('0'), null)
    assert.equal(parsePositiveInt('NaN'), null)
    assert.equal(parsePositiveIntParam('500', 20, 100), 100)
    assert.equal(parsePositiveIntParam('bad', 20, 100), 20)
  })
})
