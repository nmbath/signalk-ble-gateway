'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { modelName } = require('../lib/victron-models')

test('names products confirmed against real units', () => {
  assert.equal(modelName(0xa3a5), 'Smart Battery Sense (Rev2)')
  assert.equal(modelName(0xa3e4), 'Lynx Smart BMS NG 500A')
})
