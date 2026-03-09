/**
 * Safe recursive-descent expression evaluator for NodeOps policy rules.
 * Supports: comparisons (>, <, >=, <=, ==, !=), logic (&&, ||, !),
 * variable references, and numeric literals. No eval() usage.
 */

// --- Lexer ---

type TokenType =
  | "NUMBER"
  | "IDENT"
  | "AND"
  | "OR"
  | "NOT"
  | "GTE"
  | "LTE"
  | "GT"
  | "LT"
  | "EQ"
  | "NEQ"
  | "LPAREN"
  | "RPAREN"
  | "EOF"

interface Token {
  type: TokenType
  value: string
}

function tokenize(expr: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  while (i < expr.length) {
    // Skip whitespace
    if (/\s/.test(expr[i])) { i++; continue }

    // Two-char operators
    if (i + 1 < expr.length) {
      const two = expr[i] + expr[i + 1]
      if (two === "&&") { tokens.push({ type: "AND", value: two }); i += 2; continue }
      if (two === "||") { tokens.push({ type: "OR", value: two }); i += 2; continue }
      if (two === ">=") { tokens.push({ type: "GTE", value: two }); i += 2; continue }
      if (two === "<=") { tokens.push({ type: "LTE", value: two }); i += 2; continue }
      if (two === "==") { tokens.push({ type: "EQ", value: two }); i += 2; continue }
      if (two === "!=") { tokens.push({ type: "NEQ", value: two }); i += 2; continue }
    }

    // Single-char operators
    if (expr[i] === ">") { tokens.push({ type: "GT", value: ">" }); i++; continue }
    if (expr[i] === "<") { tokens.push({ type: "LT", value: "<" }); i++; continue }
    if (expr[i] === "!") { tokens.push({ type: "NOT", value: "!" }); i++; continue }
    if (expr[i] === "(") { tokens.push({ type: "LPAREN", value: "(" }); i++; continue }
    if (expr[i] === ")") { tokens.push({ type: "RPAREN", value: ")" }); i++; continue }

    // Numbers (integers and decimals)
    if (/[0-9]/.test(expr[i])) {
      let num = ""
      while (i < expr.length && /[0-9.]/.test(expr[i])) { num += expr[i]; i++ }
      tokens.push({ type: "NUMBER", value: num })
      continue
    }

    // Identifiers (variable names)
    if (/[a-zA-Z_]/.test(expr[i])) {
      let id = ""
      while (i < expr.length && /[a-zA-Z0-9_]/.test(expr[i])) { id += expr[i]; i++ }
      tokens.push({ type: "IDENT", value: id })
      continue
    }

    throw new Error(`unexpected character: '${expr[i]}' at position ${i}`)
  }

  tokens.push({ type: "EOF", value: "" })
  return tokens
}

// --- Parser ---

class Parser {
  private tokens: Token[]
  private pos = 0
  private vars: Record<string, number>

  constructor(tokens: Token[], vars: Record<string, number>) {
    this.tokens = tokens
    this.vars = vars
  }

  private peek(): Token {
    return this.tokens[this.pos]
  }

  private advance(): Token {
    const tok = this.tokens[this.pos]
    this.pos++
    return tok
  }

  private expect(type: TokenType): Token {
    const tok = this.peek()
    if (tok.type !== type) {
      throw new Error(`expected ${type}, got ${tok.type} ('${tok.value}')`)
    }
    return this.advance()
  }

  /** Entry: parse full expression */
  parse(): boolean {
    const result = this.parseOr()
    if (this.peek().type !== "EOF") {
      throw new Error(`unexpected token: ${this.peek().value}`)
    }
    return result
  }

  /** OR: expr || expr */
  private parseOr(): boolean {
    let left = this.parseAnd()
    while (this.peek().type === "OR") {
      this.advance()
      const right = this.parseAnd()
      left = left || right
    }
    return left
  }

  /** AND: expr && expr */
  private parseAnd(): boolean {
    let left = this.parseNot()
    while (this.peek().type === "AND") {
      this.advance()
      const right = this.parseNot()
      left = left && right
    }
    return left
  }

  /** NOT: !expr */
  private parseNot(): boolean {
    if (this.peek().type === "NOT") {
      this.advance()
      return !this.parseNot()
    }
    return this.parseComparison()
  }

  /** Comparison: value op value */
  private parseComparison(): boolean {
    const left = this.parseValue()
    const op = this.peek().type
    if (op === "GT" || op === "LT" || op === "GTE" || op === "LTE" || op === "EQ" || op === "NEQ") {
      this.advance()
      const right = this.parseValue()
      switch (op) {
        case "GT": return left > right
        case "LT": return left < right
        case "GTE": return left >= right
        case "LTE": return left <= right
        case "EQ": return left === right
        case "NEQ": return left !== right
      }
    }
    // Truthy check for standalone value (non-zero = true)
    return left !== 0
  }

  /** Value: number | variable | (expr) */
  private parseValue(): number {
    const tok = this.peek()

    if (tok.type === "NUMBER") {
      this.advance()
      const num = Number(tok.value)
      if (!Number.isFinite(num)) throw new Error(`invalid number: ${tok.value}`)
      return num
    }

    if (tok.type === "IDENT") {
      this.advance()
      if (!Object.hasOwn(this.vars, tok.value)) {
        throw new Error(`undefined variable: ${tok.value}`)
      }
      return this.vars[tok.value]
    }

    if (tok.type === "LPAREN") {
      this.advance()
      const result = this.parseOr()
      this.expect("RPAREN")
      return result ? 1 : 0
    }

    throw new Error(`unexpected token: ${tok.type} ('${tok.value}')`)
  }
}

// --- Public API ---

/**
 * Safely evaluate a boolean condition expression against a variable context.
 * No eval() or Function() — uses a recursive descent parser.
 */
export function evaluateCondition(
  expr: string,
  vars: Record<string, number>,
): boolean {
  if (!expr || expr.trim().length === 0) {
    throw new Error("empty expression")
  }
  // Cap expression length to prevent abuse
  if (expr.length > 1024) {
    throw new Error("expression too long (max 1024 characters)")
  }
  const tokens = tokenize(expr)
  const parser = new Parser(tokens, vars)
  return parser.parse()
}
