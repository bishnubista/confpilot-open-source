function tokenize(expression) {
  const tokens = []
  let offset = 0
  while (offset < expression.length) {
    const rest = expression.slice(offset)
    const whitespace = rest.match(/^\s+/)
    if (whitespace) {
      offset += whitespace[0].length
      continue
    }
    const token = rest.match(/^(\(|\)|AND\b|OR\b|[A-Za-z0-9][A-Za-z0-9.+-]*)/)
    if (!token) throw new Error(`Invalid SPDX expression near ${JSON.stringify(rest)}`)
    tokens.push(token[1])
    offset += token[1].length
  }
  return tokens
}

/**
 * Parse the AND/OR subset used by npm package license declarations.
 *
 * SPDX gives AND higher precedence than OR. Parentheses override that
 * precedence. Unsupported or malformed syntax fails closed rather than being
 * simplified into a different licensing choice.
 */
export function evaluateSpdxExpression(expression, compatible) {
  const tokens = tokenize(expression.trim())
  let cursor = 0

  const parsePrimary = () => {
    const token = tokens[cursor]
    if (token === '(') {
      cursor += 1
      const value = parseOr()
      if (tokens[cursor] !== ')') throw new Error('Unclosed SPDX expression group')
      cursor += 1
      return value
    }
    if (!token || token === ')' || token === 'AND' || token === 'OR') {
      throw new Error(`Expected SPDX license identifier, received ${token ?? 'end of input'}`)
    }
    cursor += 1
    return compatible.has(token)
  }

  const parseAnd = () => {
    let value = parsePrimary()
    while (tokens[cursor] === 'AND') {
      cursor += 1
      const right = parsePrimary()
      value = value && right
    }
    return value
  }

  const parseOr = () => {
    let value = parseAnd()
    while (tokens[cursor] === 'OR') {
      cursor += 1
      const right = parseAnd()
      value = value || right
    }
    return value
  }

  if (tokens.length === 0) throw new Error('Empty SPDX expression')
  const result = parseOr()
  if (cursor !== tokens.length) throw new Error(`Unexpected SPDX token ${tokens[cursor]}`)
  return result
}
