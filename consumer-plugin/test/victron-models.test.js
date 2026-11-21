'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { isShuntBatteryMonitor, modelName } = require('../lib/victron-models')

test('names products confirmed against real units', () => {
  assert.equal(modelName(0xa3a5), 'Smart Battery Sense (Rev2)')
  assert.equal(modelName(0xa3e4), 'Lynx Smart BMS NG 500A')
  assert.equal(modelName(0xc0a3), 'SmartShunt 500A/50mV')
})

test('recognises BMVs and SmartShunts as shunt battery monitors', () => {
  assert.deepEqual([0xa389, 0xc035, 0xc0a3, 0xa3a5, 0xa196, 0xa3e4].map(isShuntBatteryMonitor),
    [true, true, true, false, false, false])
})
