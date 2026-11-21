'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { VictronDiscovery } = require('../lib/discovery')

// Instant Readout header with a product ID and record type; the bytes after
// the key check byte stand in for encrypted readings.
function readout(modelId, recordType = 0x02) {
  const payload = Buffer.from([0x10, 0x00, 0, 0, recordType, 0x34, 0x12, 0x86, 1, 2, 3, 4])
  payload.writeUInt16LE(modelId, 2)
  return { 737: payload.toString('hex') }
}

test('identifies a Victron device from its clear header without a key', () => {
  const discovery = new VictronDiscovery()
  discovery.observe({ mac: 'd5:9e:f7:d6:f6:92', rssi: -74, manufacturerData: readout(0xa3a5) }, 1000)

  assert.deepEqual(discovery.get('D5:9E:F7:D6:F6:92'), {
    mac: 'D5:9E:F7:D6:F6:92',
    modelId: 0xa3a5,
    recordType: 0x02,
    rssi: -74,
    lastSeen: new Date(1000).toISOString(),
    advertisedName: null
  })
})

test('keeps a name advertised in a packet without readings', () => {
  const discovery = new VictronDiscovery()
  discovery.observe({ mac: 'AA:BB:CC:DD:EE:FF', name: ' 12v Bat 1 ', manufacturerData: { 737: '0105000b27' } })
  discovery.observe({ mac: 'AA:BB:CC:DD:EE:FF', rssi: -60, manufacturerData: readout(0xa389) })
  assert.equal(discovery.get('aa:bb:cc:dd:ee:ff').advertisedName, '12v Bat 1')
  assert.equal(discovery.list().length, 1)
})

test('ignores non-Victron and malformed advertisements', () => {
  const discovery = new VictronDiscovery()
  discovery.observe({ mac: '11:22:33:44:55:66', manufacturerData: { 76: '0215' } })
  discovery.observe({ mac: '11:22:33:44:55:67', manufacturerData: { 737: '1000' } })
  discovery.observe({ mac: '11:22:33:44:55:68', manufacturerData: { 737: 'zz' } })
  discovery.observe({})
  assert.deepEqual(discovery.list(), [])
})

test('forgets the device heard least recently once full', () => {
  const discovery = new VictronDiscovery({ maxEntries: 2 })
  for (const mac of ['00:00:00:00:00:01', '00:00:00:00:00:02', '00:00:00:00:00:01', '00:00:00:00:00:03']) {
    discovery.observe({ mac, name: mac, manufacturerData: readout(0xa389) })
  }
  assert.deepEqual(discovery.list().map(device => device.mac), ['00:00:00:00:00:01', '00:00:00:00:00:03'])
  assert.equal(discovery.names.size, 2)
})
