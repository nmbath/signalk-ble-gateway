'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { deviceRows } = require('../lib/device-list')

const NOW = Date.parse('2026-11-21T15:00:00.000Z')
const ago = seconds => new Date(NOW - seconds * 1000).toISOString()

const SENSE = { mac: 'D5:9E:F7:D6:F6:92', modelId: 0xa3a5, recordType: 0x02, rssi: -70, lastSeen: ago(2), advertisedName: 'Starter Battery' }
const SHUNT = { mac: 'FE:13:F1:4F:3B:B4', modelId: 0xa389, recordType: 0x02, rssi: -60, lastSeen: ago(1), advertisedName: null }
const MPPT = { mac: 'F3:E0:07:06:6C:F9', modelId: 0xa060, recordType: 0x01, rssi: -88, lastSeen: ago(3), advertisedName: '12v Solar' }
const STALE = { mac: 'AA:00:00:00:00:01', modelId: 0xa389, recordType: 0x02, rssi: -40, lastSeen: ago(20 * 60), advertisedName: null }

test('lists heard devices with what needs no key', () => {
  const groupOf = recordType => recordType === 0x02 ? 'electrical.batteries' : null
  const [row] = deviceRows({ discovered: [SENSE], groupOf }, NOW)
  assert.deepEqual(row, {
    group: 'electrical.batteries',
    mac: SENSE.mac,
    modelId: 0xa3a5,
    modelName: 'Smart Battery Sense (Rev2)',
    recordName: 'battery_monitor',
    advertisedName: 'Starter Battery',
    rssi: -70,
    lastSeen: SENSE.lastSeen,
    supportsSecondaryBattery: false,
    configured: false
  })
})

test('joins configuration and decode state, never keys', () => {
  const rows = deviceRows({
    discovered: [SENSE, SHUNT],
    configured: [{ id: '2', name: 'Starter', mac: 'd5:9e:f7:d6:f6:92', advertisementKey: 'secret'.padEnd(32, '0') }],
    states: [{ mac: 'D5:9E:F7:D6:F6:92', online: false, decode_error: 'advertisement key check failed' }]
  }, NOW)
  const sense = rows.find(row => row.mac === SENSE.mac)
  assert.equal(sense.configured, true)
  assert.equal(sense.deviceId, '2')
  assert.equal(sense.displayName, 'Starter')
  assert.equal(sense.decodeError, 'advertisement key check failed')
  assert.equal(JSON.stringify(rows).includes('secret'), false)
  assert.equal(rows.find(row => row.mac === SHUNT.mac).supportsSecondaryBattery, true)
})

test('offers the secondary battery only for a shunt sending battery monitor records', () => {
  const dcMeter = { ...SHUNT, mac: 'C0:A3:00:00:00:01', modelId: 0xc0a3, recordType: 0x0d }
  const [row] = deviceRows({ discovered: [dcMeter] }, NOW)
  assert.equal(row.modelName, 'SmartShunt 500A/50mV')
  assert.equal(row.recordName, 'dc_energy_meter')
  assert.equal(row.supportsSecondaryBattery, false)
})

test('keeps configured devices that are not heard and drops stale unconfigured ones', () => {
  const rows = deviceRows({
    discovered: [STALE],
    configured: [{ id: 'house', name: 'House', mac: '11:22:33:44:55:66' }]
  }, NOW)
  assert.deepEqual(rows.map(row => [row.mac, row.configured, row.lastSeen]), [['11:22:33:44:55:66', true, null]])
})

test('sorts configured devices first, then by signal strength', () => {
  const rows = deviceRows({
    discovered: [MPPT, SHUNT, SENSE],
    configured: [{ id: '2', name: 'Starter', mac: SENSE.mac }]
  }, NOW)
  assert.deepEqual(rows.map(row => row.mac), [SENSE.mac, SHUNT.mac, MPPT.mac])
})
