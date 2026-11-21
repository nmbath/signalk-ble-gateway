'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { buildSchema, detectionSummary, macPattern } = require('../lib/config-schema')
const { isShuntBatteryMonitor } = require('../lib/victron-models')

const SHUNT = { mac: 'AA:BB:CC:DD:EE:FF', modelId: 0xa389, rssi: -61, lastSeen: '2026-11-21T14:00:00.000Z' }
const SENSE = {
  mac: 'D5:9E:F7:D6:F6:92', modelId: 0xa3a5, advertisedName: 'Victron Energy BV',
  rssi: -74, lastSeen: '2026-11-21T14:00:57.000Z'
}
const NOW = Date.parse('2026-11-21T14:01:00.000Z')

function branchFor(schema, mac) {
  return schema.properties.devices.items.dependencies.mac.oneOf
    .find(branch => new RegExp(branch.properties.mac.pattern ?? '(?!)', 'u').test(mac))
}

test('says a device is not detected until something has been decoded', () => {
  const item = buildSchema().properties.devices.items
  assert.match(item.description, /Not detected yet/)
  assert.equal(item.properties.secondaryBattery, undefined)
  assert.equal(item.dependencies, undefined)
})

test('describes each detected device on its own row', () => {
  const schema = buildSchema([SHUNT, SENSE], NOW)
  assert.equal(
    branchFor(schema, ' d5:9e:f7:d6:f6:92 ').description,
    'Detected: Smart Battery Sense (Rev2) (0xA3A5) · advertised as "Victron Energy BV" · RSSI -74 dBm · last seen 3 s ago'
  )
  assert.match(branchFor(schema, SHUNT.mac).description, /^Detected: SmartShunt 500A\/50mV \(0xA389\) · RSSI -61 dBm · last seen 1 min ago$/)
})

test('offers the secondary battery option only on detected shunt rows', () => {
  const schema = buildSchema([SHUNT, SENSE], NOW)
  assert.equal(branchFor(schema, SHUNT.mac).properties.secondaryBattery.type, 'string')
  assert.equal(branchFor(schema, SENSE.mac).properties.secondaryBattery, undefined)
})

test('keeps undetected rows marked as not detected', () => {
  const branches = buildSchema([SHUNT, SENSE], NOW).properties.devices.items.dependencies.mac.oneOf
  const notDetected = branches.at(-1)
  const anyDetected = new RegExp(notDetected.properties.mac.not.pattern, 'u')
  assert.match(notDetected.description, /Not detected yet/)
  assert.equal(notDetected.properties.secondaryBattery, undefined)
  assert.equal(anyDetected.test(SHUNT.mac), true)
  assert.equal(anyDetected.test(SENSE.mac.toLowerCase()), true)
  assert.equal(anyDetected.test('11:22:33:44:55:66'), false)
})

test('names an unknown model by its ID and rounds older sightings', () => {
  assert.equal(
    detectionSummary({ modelId: 0xfffe, lastSeen: '2026-11-21T11:00:00.000Z' }, NOW),
    'Detected: Unknown Victron model (0xFFFE) · last seen 3 h ago'
  )
})

// The admin form (RJSF with AJV) compiles patterns with the Unicode flag.
test('produces a pattern that compiles in Unicode mode', () => {
  const pattern = macPattern(['D5:9E:F7:D6:F6:92', 'A.B'])
  assert.doesNotThrow(() => new RegExp(pattern, 'u'))
  assert.equal(new RegExp(pattern, 'u').test('d5:9e:f7:d6:f6:92'), true)
  assert.equal(new RegExp(pattern, 'u').test('AxB'), false)
})

test('matches any of several MAC addresses', () => {
  const pattern = new RegExp(macPattern(['AA:BB:CC:DD:EE:FF', '11:22:33:44:55:66']))
  assert.equal(pattern.test('11:22:33:44:55:66'), true)
  assert.equal(pattern.test('aa:bb:cc:dd:ee:ff'), true)
  assert.equal(pattern.test('AA:BB:CC:DD:EE:FF|11'), false)
})

test('recognises BMV and SmartShunt models but not a Smart Battery Sense', () => {
  for (const id of [0x0203, 0xa381, 0xa389, 0xa38c, 0xc030]) {
    assert.equal(isShuntBatteryMonitor(id), true, id.toString(16))
  }
  // Smart Battery Sense, SmartShunt Bluetooth Interface, Lynx Smart BMS,
  // SmartSolar MPPT and an unknown ID.
  for (const id of [0xa3a5, 0xa196, 0xa3e5, 0xa060, 0xfffe]) {
    assert.equal(isShuntBatteryMonitor(id), false, id.toString(16))
  }
})
