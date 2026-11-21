'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const panel = require('../public/remoteEntry')

const KEY = '00112233445566778899aabbccddeeff'
const NOW = Date.parse('2026-11-21T15:00:00.000Z')
const ago = seconds => new Date(NOW - seconds * 1000).toISOString()

const SENSE_ROW = {
  mac: 'D5:9E:F7:D6:F6:92', modelId: 0xa3a5, modelName: 'Smart Battery Sense (Rev2)',
  recordName: 'battery_monitor', advertisedName: 'Starter Battery', rssi: -70, lastSeen: ago(2),
  supportsSecondaryBattery: false, configured: false
}
const SHUNT_ROW = {
  mac: 'FE:13:F1:4F:3B:B4', modelId: 0xa389, modelName: 'SmartShunt 500A/50mV',
  recordName: 'battery_monitor', advertisedName: null, rssi: -60, lastSeen: ago(12),
  supportsSecondaryBattery: true, configured: false
}
const MPPT_ROW = {
  mac: 'F3:E0:07:06:6C:F9', modelId: 0xa060, modelName: 'SmartSolar Charger MPPT 100/20 48V',
  recordName: 'solar_charger', advertisedName: '12v <b>Solar</b>', rssi: -88, lastSeen: ago(90),
  supportsSecondaryBattery: false, configured: false
}
const CONFIGURATION = {
  discovered: null,
  devices: [{ id: '2', name: 'Starter Battery', mac: 'd5:9e:f7:d6:f6:92', advertisementKey: KEY, extra: 'kept' }]
}

// The admin UI's share scope: { react: { <version>: { get } } }
function shareScope(...versions) {
  return {
    react: Object.fromEntries(versions.map(([version, lib]) =>
      [version, { get: () => Promise.resolve(() => lib) }]))
  }
}

test('gives the admin UI a panel built on the React it shares', async () => {
  const { container } = panel
  await container.init(shareScope(['16.14.0', { legacy: true }], [React.version, React]))
  const factory = await container.get('./PluginConfigurationPanel')
  const Panel = factory().default
  assert.equal(typeof Panel, 'function')
  assert.equal(typeof Panel.parts.DeviceTable, 'function')
  await assert.rejects(container.get('./AppPanel'), /exposes no \.\/AppPanel/)
})

test('loads as a classic script that the admin UI does not take for a React 16 remote', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'remoteEntry.js'), 'utf8')
  // The admin UI scans remotes for ("react","<major>. to detect legacy React
  assert.equal(/\("react","\d+\./.test(source), false)
  const window = {}
  new Function('window', 'module', source)(window, undefined)
  assert.equal(typeof window.signalk_victron_ble_consumer.init, 'function')
  assert.equal(typeof window.signalk_victron_ble_consumer.get, 'function')
})

test('fills a new device from what was heard', () => {
  assert.deepEqual(panel.draftFor(SENSE_ROW, {}), {
    isNew: true, mac: SENSE_ROW.mac, name: 'Starter Battery', id: '', advertisementKey: '',
    enabled: true, secondaryBattery: ''
  })
  assert.equal(panel.draftFor(SHUNT_ROW, {}).name, 'SmartShunt 500A/50mV')
  const existing = panel.draftFor(SENSE_ROW, CONFIGURATION)
  assert.equal(existing.isNew, false)
  assert.equal(existing.id, '2')
  assert.equal(existing.advertisementKey, KEY)
})

test('validates the fields before saving', () => {
  const draft = { ...panel.draftFor(MPPT_ROW, CONFIGURATION), name: ' ', id: '2', advertisementKey: 'abc', secondaryBattery: 'a.b' }
  assert.deepEqual(Object.keys(panel.validate(draft, CONFIGURATION)).sort(),
    ['advertisementKey', 'id', 'name', 'secondaryBattery'])
  assert.match(panel.validate(draft, CONFIGURATION).id, /already uses/)
  assert.deepEqual(panel.validate({ ...draft, name: 'Solar', id: 'solar1', advertisementKey: KEY.toUpperCase(), secondaryBattery: '' }, CONFIGURATION), {})
  assert.match(panel.validate({ ...draft, id: 'x y' }, CONFIGURATION).id, /letters, digits/)
  // Changing a device may keep its own ID
  assert.deepEqual(panel.validate(panel.draftFor(SENSE_ROW, CONFIGURATION), CONFIGURATION), {})
})

test('adds, changes and removes devices in the configuration', () => {
  const added = panel.applyDraft(CONFIGURATION, {
    ...panel.draftFor(SHUNT_ROW, CONFIGURATION), name: ' House ', id: 'house', advertisementKey: KEY.toUpperCase(), secondaryBattery: 'starter'
  })
  assert.equal('discovered' in added, false)
  assert.deepEqual(added.devices[1], {
    id: 'house', name: 'House', mac: SHUNT_ROW.mac, advertisementKey: KEY, enabled: true, secondaryBattery: 'starter'
  })

  const changed = panel.applyDraft(added, { ...panel.draftFor(SENSE_ROW, added), name: 'Engine start', enabled: false })
  assert.deepEqual(changed.devices[0], {
    id: '2', name: 'Engine start', mac: SENSE_ROW.mac, advertisementKey: KEY, enabled: false, extra: 'kept'
  })

  const removed = panel.removeDevice(changed, SENSE_ROW.mac)
  assert.deepEqual(removed.devices.map(device => device.id), ['house'])
  assert.equal(CONFIGURATION.devices.length, 1)
})

test('lists configured devices from the configuration being edited', () => {
  const rows = panel.mergeRows([MPPT_ROW, SENSE_ROW], {
    devices: [...CONFIGURATION.devices, { id: 'house', name: 'House', mac: '11:22:33:44:55:66' }]
  })
  assert.deepEqual(rows.map(row => [row.mac, row.configured]), [
    [SENSE_ROW.mac, true], ['11:22:33:44:55:66', true], [MPPT_ROW.mac, false]
  ])
  assert.equal(rows[0].displayName, 'Starter Battery')
  assert.equal(rows[1].lastSeen, null)
})

test('groups devices into Configured and type tabs', () => {
  const rows = panel.mergeRows([SENSE_ROW, SHUNT_ROW, MPPT_ROW], CONFIGURATION)
  assert.deepEqual(panel.tabsFor(rows).map(tab => [tab.key, tab.rows.length]),
    [['configured', 1], ['batteries', 2], ['converters', 1]])
  assert.deepEqual(['orion_xs', 'dc_dc_converter', 'ac_charger', 've_bus', 'multi_rs'].map(recordName =>
    panel.typeTabOf({ recordName })), Array(5).fill('converters'))
  assert.equal(panel.typeTabOf({ recordName: 'battery_protect' }), 'battery-protect')
  assert.equal(panel.typeTabOf({ recordName: 'dc_energy_meter' }), 'dc-energy-meters')
  assert.equal(panel.typeTabOf({ recordName: 'gx_device' }), 'other')
  assert.equal(panel.typeTabOf({ recordName: null }), null)
})

test('reports the state of configured devices', () => {
  assert.equal(panel.statusOf(SENSE_ROW), null)
  const configured = { ...SENSE_ROW, configured: true, enabled: true }
  assert.equal(panel.statusOf({ ...configured, online: true }).label, 'Online')
  assert.equal(panel.statusOf({ ...configured, decodeError: 'advertisement key check failed' }).label, 'Wrong key')
  assert.equal(panel.statusOf({ ...configured, lastSeen: null }).label, 'Not heard')
  assert.equal(panel.statusOf({ ...configured, enabled: false }).label, 'Disabled')
  assert.equal(panel.statusOf(configured).label, 'Waiting')
})

test('formats signal and age like the BLE Manager', () => {
  assert.deepEqual([-41, -55, -72, -90].map(panel.rssiColor), ['success', 'primary', 'warning', 'danger'])
  assert.deepEqual([ago(2), ago(12), ago(90), ago(7200), null].map(seen => panel.formatAge(seen, NOW)),
    ['just now', '12s ago', '1m ago', '2h ago', '-'])
})

test('renders the device table with the admin UI styles', () => {
  const { DeviceTable } = panel.createPanel(React).parts
  const rows = panel.mergeRows([SENSE_ROW, MPPT_ROW], CONFIGURATION)
  const html = renderToStaticMarkup(React.createElement(DeviceTable, {
    rows, now: NOW, selected: SENSE_ROW.mac, onSelect: () => {}, empty: ''
  }))
  assert.match(html, /class="table table-hover table-striped table-sm mb-0"/)
  assert.match(html, /<tr class="table-active"[^>]*><td>Starter Battery<\/td><td>Smart Battery Sense \(Rev2\)<\/td>/)
  assert.match(html, /badge bg-primary">-70 dBm/)
  assert.match(html, /badge bg-warning">Waiting/)
  assert.match(html, /Not configured/)
  // Advertised names come from the air and must not become markup
  assert.match(html, /12v &lt;b&gt;Solar&lt;\/b&gt;/)
})

test('renders the settings of a device, with secondary battery only for a shunt', () => {
  const { Editor } = panel.createPanel(React).parts
  const render = row => renderToStaticMarkup(React.createElement(Editor, {
    row, draft: panel.draftFor(row, CONFIGURATION), setDraft: () => {}, configuration: CONFIGURATION,
    showErrors: true, onSave: () => {}, onRemove: () => {}, onCancel: () => {}
  }))

  const shunt = render(SHUNT_ROW)
  assert.match(shunt, /Add <\/strong><strong>SmartShunt 500A\/50mV/)
  assert.match(shunt, /Secondary battery ID/)
  assert.match(shunt, />Add device</)
  assert.equal(shunt.includes('>Remove<'), false)
  assert.match(shunt, /is-invalid/)

  const sense = render(SENSE_ROW)
  assert.equal(sense.includes('Secondary battery ID'), false)
  assert.match(sense, />Save</)
  assert.match(sense, />Remove</)
  assert.equal(sense.includes('is-invalid'), false)
})
