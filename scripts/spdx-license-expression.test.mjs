import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateSpdxExpression } from './spdx-license-expression.mjs'

const compatible = new Set(['MIT', 'Apache-2.0', 'ISC'])

test('evaluates nested SPDX groups without dropping their constraints', () => {
  assert.equal(evaluateSpdxExpression('(MIT OR GPL-3.0-only) AND Apache-2.0', compatible), true)
  assert.equal(evaluateSpdxExpression('(MIT OR GPL-3.0-only) AND GPL-2.0-only', compatible), false)
  assert.equal(evaluateSpdxExpression('MIT OR (GPL-3.0-only AND GPL-2.0-only)', compatible), true)
})

test('applies SPDX AND precedence before OR', () => {
  assert.equal(evaluateSpdxExpression('MIT OR GPL-3.0-only AND GPL-2.0-only', compatible), true)
  assert.equal(evaluateSpdxExpression('GPL-3.0-only OR MIT AND Apache-2.0', compatible), true)
})

test('fails closed on malformed or unsupported syntax', () => {
  assert.throws(() => evaluateSpdxExpression('(MIT OR Apache-2.0', compatible), /Unclosed/)
  assert.throws(() => evaluateSpdxExpression('MIT WITH Classpath-exception-2.0', compatible), /Unexpected/)
  assert.throws(() => evaluateSpdxExpression('', compatible), /Empty/)
})
