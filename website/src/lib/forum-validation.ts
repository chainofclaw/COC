export function getRequiredString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function isHexAddress(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
}

export function parsePositiveInt(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) return null
  return parsed
}

export function parsePositiveIntParam(value: string | null, fallback: number, max: number): number {
  const parsed = parsePositiveInt(value)
  if (parsed === null) return fallback
  return Math.min(parsed, max)
}
