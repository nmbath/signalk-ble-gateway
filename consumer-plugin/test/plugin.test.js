'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const createPlugin = require('../index')
const { identityDelta, measurementDelta, sensorPath } = require('../index')

function harness() {
  const app = new EventEmitter()
  const statuses = []
  app.setPluginStatus = value => statuses.push(value)
  app.setPluginError = value => statuses.push(value)
  app.handleMessage = () => {}
  const advertisementCallbacks = new Map()
  app.bleApi = {
    onAdvertisement: (pluginId, callback) => {
      advertisementCallbacks.set(pluginId, callback)
      return () => advertisementCallbacks.delete(pluginId)
    }
  }
  const routes = new Map()
  const router = { get: (path, handler) => routes.set(path, handler) }
  const plugin = createPlugin(app)
  plugin.registerWithRouter(router)
  return { app, plugin, routes, statuses, advertisementCallbacks }
}

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this }
  }
}

test('subscribes and unsubscribes through the official BLE API', () => {
  const instance = harness()
  instance.plugin.start({ devices: [] })
  assert.equal(instance.advertisementCallbacks.has(instance.plugin.id), true)
  instance.plugin.stop()
  assert.equal(instance.advertisementCallbacks.size, 0)
})

test('reports a clear error when the BLE API is unavailable', () => {
  const instance = harness()
  delete instance.app.bleApi
  instance.plugin.start({ devices: [] })
  assert.match(instance.statuses.at(-1), /requires.*PR #2588/i)
  assert.equal(instance.advertisementCallbacks.size, 0)
})

function readout(modelId, keyHex) {
  const key = Buffer.from(keyHex, 'hex')
  const header = Buffer.from([0x10, 0x00, 0, 0, 0x02, 0x01, 0x00, key[0]])
  header.writeUInt16LE(modelId, 2)
  const counter = Buffer.alloc(16)
  counter.writeUInt16LE(1, 0)
  const cipher = require('node:crypto').createCipheriv('aes-128-ctr', key, counter)
  const body = Buffer.concat([cipher.update(Buffer.alloc(16)), cipher.final()])
  return Buffer.concat([header, body]).toString('hex')
}

test('serves the configuration panel rows, kept across a restart', () => {
  const instance = harness()
  const key = '00112233445566778899AABBCCDDEEFF'
  const settings = { devices: [{ id: '2', name: 'Starter', mac: '11:22:33:44:55:66', advertisementKey: key }] }
  instance.plugin.start(settings)
  const deliver = instance.advertisementCallbacks.get(instance.plugin.id)
  deliver({ mac: '11:22:33:44:55:66', rssi: -70, name: 'Starter sense', manufacturerData: { 737: readout(0xa3a5, key) } })
  deliver({ mac: 'aa:bb:cc:dd:ee:ff', rssi: -61, manufacturerData: { 737: readout(0xa389, '11112233445566778899AABBCCDDEEFF') } })

  const devices = () => {
    const response = responseRecorder()
    instance.routes.get('/devices')({}, response)
    assert.equal(response.statusCode, 200)
    return response.body
  }
  const rows = () => devices().devices
  assert.equal(devices().running, true)
  const [sense, shunt] = rows()
  assert.equal(sense.mac, '11:22:33:44:55:66')
  assert.equal(sense.configured, true)
  assert.equal(sense.online, true)
  assert.equal(sense.advertisedName, 'Starter sense')
  assert.equal(sense.modelName, 'Smart Battery Sense (Rev2)')
  assert.equal(shunt.mac, 'AA:BB:CC:DD:EE:FF')
  assert.equal(shunt.configured, false)
  assert.equal(shunt.supportsSecondaryBattery, true)
  assert.equal(JSON.stringify(rows()).includes(key), false)

  // Saving the configuration restarts the plugin; what was heard is kept.
  instance.plugin.stop()
  // A stopped (disabled) plugin says so, so the panel can explain the empty list
  assert.equal(devices().running, false)
  instance.plugin.start(settings)
  assert.equal(rows().length, 2)
  assert.equal(devices().running, true)
})

test('declares a configuration panel instead of a generated form', () => {
  const instance = harness()
  const pkg = require('../package.json')
  assert.equal(pkg.keywords.includes('signalk-plugin-configurator'), true)
  assert.notEqual(pkg.type, 'module')
  assert.equal(instance.plugin.uiSchema, undefined)
  assert.equal(instance.plugin.schema.properties.devices.type, 'array')
})

test('publishes identity once per change and reception with every reading', () => {
  const instance = harness()
  const deltas = []
  instance.app.handleMessage = (_id, delta) => deltas.push(delta)
  const key = '00112233445566778899AABBCCDDEEFF'
  const mac = '11:22:33:44:55:66'
  instance.plugin.start({ devices: [{ id: 'starter', name: 'Starter Battery', mac, advertisementKey: key }] })
  const deliver = instance.advertisementCallbacks.get(instance.plugin.id)
  const valuesOf = delta => Object.fromEntries(delta.updates[0].values.map(({ path, value }) => [path, value]))

  deliver({ mac, rssi: -74, manufacturerData: { 737: readout(0xa3a5, key) } })
  deliver({ mac, rssi: -75, manufacturerData: { 737: readout(0xa3a5, key) } })
  const identities = deltas.filter(delta => delta.updates[0].meta)
  assert.equal(identities.length, 1)
  assert.deepEqual(valuesOf(identities[0]), {
    'sensors.11-22-33-44-55-66.name': 'Starter Battery',
    'sensors.11-22-33-44-55-66.sensorType': 'Smart Battery Sense (Rev2)',
    'sensors.11-22-33-44-55-66.vendor': 'Victron Energy',
    'sensors.11-22-33-44-55-66.dataType': 'electrical.batteries',
    'sensors.11-22-33-44-55-66.instance': 'starter',
    'electrical.batteries.starter.name': 'Starter Battery'
  })
  const readings = deltas.filter(delta => !delta.updates[0].meta).map(valuesOf)
  assert.deepEqual(readings.map(values => values['sensors.11-22-33-44-55-66.RSSI']), [-74, -75])
  assert.match(readings[1]['sensors.11-22-33-44-55-66.lastSeen'], /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(deltas.flatMap(delta => delta.updates[0].values).some(({ path }) => /\.ble\.|manufacturer/.test(path)), false)

  // A newly advertised name changes the identity, so it is published again.
  deliver({ mac, rssi: -70, name: '12v Starter', manufacturerData: { 737: '0105000b27' } })
  deliver({ mac, rssi: -74, manufacturerData: { 737: readout(0xa3a5, key) } })
  const latest = deltas.filter(delta => delta.updates[0].meta).at(-1)
  assert.equal(valuesOf(latest)['sensors.11-22-33-44-55-66.advertisedName'], '12v Starter')
})

test('identifies a sensor without an electrical group, with no data link', () => {
  const delta = identityDelta(
    { id: 'protect', name: 'Protect', mac: 'aa:bb:cc:dd:ee:ff' },
    { record_type: 0x09, model_id: 0xfffe, model_name: null },
    null
  )
  const paths = Object.fromEntries(delta.updates[0].values.map(({ path, value }) => [path, value]))
  assert.deepEqual(paths, {
    'sensors.AA-BB-CC-DD-EE-FF.name': 'Protect',
    'sensors.AA-BB-CC-DD-EE-FF.sensorType': '0xFFFE',
    'sensors.AA-BB-CC-DD-EE-FF.vendor': 'Victron Energy'
  })
})

test('keys the sensor path by MAC written with dashes', () => {
  assert.equal(sensorPath({ mac: ' d5:9e:f7:d6:f6:92 ' }), 'sensors.D5-9E-F7-D6-F6-92')
})

test('status route masks configured keys', () => {
  const instance = harness()
  const key = '00112233445566778899AABBCCDDEEFF'
  instance.plugin.start({ devices: [{
    id: 'house', name: 'House', mac: 'AA:BB:CC:DD:EE:FF',
    advertisementKey: key
  }] })
  const response = responseRecorder()
  instance.routes.get('/status')({}, response)

  assert.equal(response.statusCode, 200)
  assert.equal(response.body.devices[0].key_configured, true)
  assert.equal(JSON.stringify(response.body).includes(key), false)
})

test('publishes Lynx measurements on battery paths', () => {
  const delta = measurementDelta({ id: 'house' }, {
    record_type: 0x0a,
    measurements: {
      battery_voltage_v: 13.29,
      battery_current_a: 8.7,
      state_of_charge_percent: 67.1,
      time_to_go_s: 90000,
      temperature_c: 32
    }
  })

  assert.deepEqual(delta.updates[0].values, [
    { path: 'electrical.batteries.house.voltage', value: 13.29 },
    { path: 'electrical.batteries.house.current', value: 8.7 },
    { path: 'electrical.batteries.house.capacity.stateOfCharge', value: 0.671 },
    { path: 'electrical.batteries.house.capacity.timeRemaining', value: 90000 },
    { path: 'electrical.batteries.house.temperature', value: 305.15 }
  ])
})

test('publishes a VE.Bus inverter/charger on the paths signalk-venus-plugin uses', () => {
  const { decodeVeBus } = require('../lib/victron')
  // A MultiPlus-II on shore power, decrypted from a live advertisement
  const measurements = decodeVeBus(Buffer.from('fc000000520a5d00f80100b5e2', 'hex'))
  const device = { id: 'multi', name: 'MultiPlus', mac: 'F5:50:41:11:71:20' }
  const delta = measurementDelta(device, { record_type: 0x0c, measurements })
  assert.deepEqual(delta.updates[0].values.filter(({ path }) => path.startsWith('electrical.')), [
    { path: 'electrical.chargers.multi.voltage', value: 26.42 },
    { path: 'electrical.chargers.multi.current', value: 0 },
    { path: 'electrical.chargers.multi.temperature', value: 286.15 },
    { path: 'electrical.chargers.multi.capacity.stateOfCharge', value: 0.69 },
    { path: 'electrical.chargers.multi.chargingMode', value: 'external control' },
    { path: 'electrical.chargers.multi.chargingModeNumber', value: 252 },
    { path: 'electrical.inverters.multi.inverterMode', value: 'external control' },
    { path: 'electrical.inverters.multi.inverterModeNumber', value: 252 },
    { path: 'electrical.inverters.multi.acin.power', value: 93 },
    { path: 'electrical.inverters.multi.acout.power', value: 63 },
    { path: 'electrical.inverters.multi.name', value: 'MultiPlus' },
    { path: 'electrical.chargers.multi.name', value: 'MultiPlus' }
  ])

  const identity = identityDelta(device, { record_type: 0x0c, model_id: 0x2615, model_name: 'MultiPlus-II 24/5000/120-50' }, null)
  const values = Object.fromEntries(identity.updates[0].values.map(({ path, value }) => [path, value]))
  assert.equal(values['sensors.F5-50-41-11-71-20.dataType'], 'electrical.inverters')
  assert.equal(values['electrical.chargers.multi.name'], 'MultiPlus')
  assert.equal(Object.keys(values).some(path => path.startsWith('electrical.batteries.')), false)
})

test('publishes an AC charger on the paths signalk-venus-plugin uses', () => {
  const output = (voltage, current) => ({ voltage_v: voltage, current_a: current })
  const measurements = {
    state: 3,
    outputs: [output(26.4, 12.5), output(13.6, 1.2), output(null, null)],
    temperature_c: 13,
    ac_current_a: 1.8
  }
  const delta = measurementDelta({ id: 'shore', name: 'Shore charger' }, { record_type: 0x08, measurements })
  assert.deepEqual(delta.updates[0].values, [
    { path: 'electrical.chargers.shore.voltage', value: 26.4 },
    { path: 'electrical.chargers.shore.current', value: 12.5 },
    { path: 'electrical.chargers.shore-second.voltage', value: 13.6 },
    { path: 'electrical.chargers.shore-second.current', value: 1.2 },
    { path: 'electrical.chargers.shore.temperature', value: 286.15 },
    { path: 'electrical.chargers.shore.acin.1.current', value: 1.8 },
    { path: 'electrical.chargers.shore.chargingMode', value: 'bulk' },
    { path: 'electrical.chargers.shore.chargingModeNumber', value: 3 },
    { path: 'electrical.chargers.shore.name', value: 'Shore charger' }
  ])
})

test('publishes SmartLithium cells and balancer status like bt-sensors', () => {
  const cell = voltage => ({ bound: 'exact', voltage_v: voltage })
  const measurements = {
    battery_voltage_v: 1312 * 0.01,
    temperature_c: 15,
    cell_voltages_v: [cell(3.28), cell(3.29), { bound: 'below', voltage_v: 2.61 }, cell(3.27), null, null, null, null],
    balancer_status: 1,
    balancer_status_name: 'balanced'
  }
  const delta = measurementDelta({ id: '10' }, { record_type: 0x05, measurements })
  assert.deepEqual(delta.updates[0].values, [
    { path: 'electrical.batteries.10.voltage', value: 13.12 },
    { path: 'electrical.batteries.10.temperature', value: 288.15 },
    { path: 'electrical.batteries.10.cell1.voltage', value: 3.28 },
    { path: 'electrical.batteries.10.cell2.voltage', value: 3.29 },
    { path: 'electrical.batteries.10.cell3.voltage', value: 2.61 },
    { path: 'electrical.batteries.10.cell4.voltage', value: 3.27 },
    { path: 'electrical.batteries.10.balancerStatus', value: 'balanced' }
  ])

  const identity = identityDelta({ id: '10', name: '12v Bat 1', mac: 'C6:88:36:CE:9C:99' },
    { record_type: 0x05, model_id: 0xa3e9, model_name: 'Smart Lithium', measurements }, null)
  const meta = Object.fromEntries(identity.updates[0].meta.map(({ path, value }) => [path, value]))
  assert.deepEqual(meta['electrical.batteries.10.cell4.voltage'], { units: 'V', description: 'Voltage of cell 4' })
  assert.equal('electrical.batteries.10.cell5.voltage' in meta, false)
  assert.match(meta['electrical.batteries.10.balancerStatus'].description, /balancing/)
})

test('publishes below a nested path, linked from the sensor', () => {
  const device = { id: '1.lithium.1', name: '12v Bat 1', mac: 'C6:88:36:CE:9C:99' }
  const decoded = { record_type: 0x05, model_id: 0xa3e9, model_name: 'Smart Lithium', measurements: { battery_voltage_v: 13.12, cell_voltages_v: [] } }
  const delta = measurementDelta(device, decoded, { rssi: -73, lastSeen: '2026-11-21T23:34:40.587Z' })
  assert.deepEqual(delta.updates[0].values.map(({ path }) => path), [
    'electrical.batteries.1.lithium.1.voltage',
    // Sent with every reading, so source priorities never hand it to another source
    'electrical.batteries.1.lithium.1.name',
    'sensors.C6-88-36-CE-9C-99.RSSI',
    'sensors.C6-88-36-CE-9C-99.lastSeen'
  ])
  const identity = Object.fromEntries(identityDelta(device, decoded, null).updates[0].values.map(({ path, value }) => [path, value]))
  assert.equal(identity['sensors.C6-88-36-CE-9C-99.dataType'], 'electrical.batteries.1.lithium')
  assert.equal(identity['sensors.C6-88-36-CE-9C-99.instance'], '1')
  assert.equal(identity['electrical.batteries.1.lithium.1.name'], '12v Bat 1')
  // A leading dot is ignored
  assert.equal(measurementDelta({ ...device, id: '.1.lithium.1' }, decoded, {}).updates[0].values[0].path,
    'electrical.batteries.1.lithium.1.voltage')
})

test('two batteries of one bank publish apart, each with its name as the source', () => {
  const bat = n => ({ id: `1.lithium.${n}`, name: `12v Bat ${n}`, mac: `C6:88:36:CE:9C:9${n}` })
  const decoded = { record_type: 0x05, model_id: 0xa3e9, measurements: { battery_voltage_v: 13.12, cell_voltages_v: [] } }
  const deltas = [bat(1), bat(2)].map(device => measurementDelta(device, decoded, {}).updates[0])
  assert.deepEqual(deltas.map(update => [update.source.src, update.values[0].path]), [
    ['12v Bat 1', 'electrical.batteries.1.lithium.1.voltage'],
    ['12v Bat 2', 'electrical.batteries.1.lithium.2.voltage']
  ])
  assert.equal(identityDelta(bat(1), decoded, null).updates[0].source.src, '12v Bat 1')
  // Without a name the MAC identifies the source
  assert.equal(measurementDelta({ id: '5', mac: 'C6:88:36:CE:9C:91' }, decoded, {}).updates[0].source.src,
    'C6:88:36:CE:9C:91')
  // Without an ID there is nowhere to publish readings
  assert.deepEqual(measurementDelta({ name: 'x' }, decoded, {}).updates[0].values, [])
})

test('publishes Orion XS measurements on the venus plugin DC-DC paths', () => {
  const delta = measurementDelta({ id: 'orionSt' }, {
    record_type: 0x0f,
    measurements: {
      output_voltage_v: 13.57,
      output_current_a: 48.8,
      input_voltage_v: 13.88,
      input_current_a: 48.8,
      state: 3,
      state_name: 'bulk',
      error: 0,
      error_name: 'no_error',
      off_reason: 0
    }
  })

  assert.deepEqual(delta.updates[0].values, [
    { path: 'electrical.dcdc.orionSt.voltage', value: 13.57 },
    { path: 'electrical.dcdc.orionSt.current', value: 48.8 },
    { path: 'electrical.dcdc.orionSt.input.voltage', value: 13.88 },
    { path: 'electrical.dcdc.orionSt.input.current', value: 48.8 },
    // signalk-venus-plugin names no DC-DC state 3, so sends its number
    { path: 'electrical.dcdc.orionSt.chargingMode', value: '3' },
    { path: 'electrical.dcdc.orionSt.chargingModeNumber', value: 3 }
  ])
})

test('publishes Solar Charger measurements on solar paths', () => {
  const delta = measurementDelta({ id: 'mppt' }, {
    record_type: 0x01,
    measurements: {
      battery_voltage_v: 13.48,
      battery_charging_current_a: 3.6,
      solar_power_w: 50,
      yield_today_j: 3348000,
      external_device_load_a: 2,
      charge_state: 'float',
      charge_state_number: 5,
      charger_error: 'no_error'
    }
  })

  assert.deepEqual(delta.updates[0].values, [
    { path: 'electrical.solar.mppt.voltage', value: 13.48 },
    { path: 'electrical.solar.mppt.current', value: 3.6 },
    { path: 'electrical.solar.mppt.panelPower', value: 50 },
    { path: 'electrical.solar.mppt.yieldToday', value: 3348000 },
    { path: 'electrical.solar.mppt.loadCurrent', value: 2 },
    { path: 'electrical.solar.mppt.controllerMode', value: 'float' },
    { path: 'electrical.solar.mppt.controllerModeNumber', value: 5 }
  ])
})

test('names solar states as signalk-venus-plugin does', () => {
  const modeFor = number => measurementDelta({ id: 'mppt' }, {
    record_type: 0x01,
    measurements: { charge_state_number: number }
  }).updates[0].values.find(v => v.path.endsWith('.controllerMode'))?.value

  assert.equal(modeFor(0), 'not charging')
  assert.equal(modeFor(4), 'absorption')
  assert.equal(modeFor(252), 'external control')
  assert.equal(modeFor(99), '99')
  assert.equal(modeFor(null), undefined)
})

test('publishes an Orion with the alternator role as the venus plugin alternator', () => {
  const delta = measurementDelta({ id: 'engine', role: 'alternator' }, {
    record_type: 0x0f,
    measurements: { output_voltage_v: 13.6, output_current_a: 20, input_voltage_v: 14.2, input_current_a: 21, state: 4 }
  })
  assert.deepEqual(delta.updates[0].values, [
    { path: 'electrical.alternator.engine.voltage', value: 13.6 },
    { path: 'electrical.alternator.engine.current', value: 20 },
    { path: 'electrical.alternator.engine.input.voltage', value: 14.2 },
    { path: 'electrical.alternator.engine.input.current', value: 21 },
    { path: 'electrical.alternator.engine.chargingMode', value: 'absorption' },
    { path: 'electrical.alternator.engine.chargingModeNumber', value: 4 }
  ])
})

test('publishes DC/DC converter voltages on the venus plugin DC-DC paths', () => {
  const delta = measurementDelta({ id: 'orionStart' }, {
    record_type: 0x04,
    measurements: {
      state: 0,
      state_name: 'off',
      error: 0,
      error_name: 'no_error',
      input_voltage_v: 13.15,
      output_voltage_v: 12.9,
      off_reason: 128,
      off_reasons: ['engine_shutdown']
    }
  })

  assert.deepEqual(delta.updates[0].values, [
    { path: 'electrical.dcdc.orionStart.voltage', value: 12.9 },
    { path: 'electrical.dcdc.orionStart.input.voltage', value: 13.15 },
    { path: 'electrical.dcdc.orionStart.chargingMode', value: 'off' },
    { path: 'electrical.dcdc.orionStart.chargingModeNumber', value: 0 }
  ])
})

test('publishes consumed charge as signalk-venus-plugin does', () => {
  const delta = measurementDelta({ id: 'house' }, {
    record_type: 0x02,
    measurements: { battery_voltage_v: 13.1, consumed_ah: -160.6 }
  })
  assert.deepEqual(delta.updates[0].values.find(v => v.path.endsWith('consumedCharge')),
    { path: 'electrical.batteries.house.capacity.consumedCharge', value: -578160 })
})

test('publishes nothing for a record type without a path builder', () => {
  const delta = measurementDelta({ id: 'shunt' }, {
    record_type: 0x07,
    measurements: { battery_voltage_v: 12.3 }
  })

  assert.deepEqual(delta.updates[0].values, [])
})

test('optionally publishes BMV auxiliary voltage as a secondary battery', () => {
  const delta = measurementDelta({ id: 'house', secondaryBattery: 'starter' }, {
    record_type: 0x02,
    measurements: {
      battery_voltage_v: 12.8,
      aux_input: 'aux_voltage',
      aux_voltage_v: 12.6
    }
  })

  assert.deepEqual(delta.updates[0].values, [
    { path: 'electrical.batteries.house.voltage', value: 12.8 },
    { path: 'electrical.batteries.starter.voltage', value: 12.6 }
  ])
})

test('publishes the secondary battery to a nested path', () => {
  const delta = measurementDelta({ secondaryBattery: 'engine.start' }, {
    record_type: 0x02,
    measurements: { aux_input: 'aux_voltage', aux_voltage_v: 12.6 }
  })
  assert.deepEqual(delta.updates[0].values, [{ path: 'electrical.batteries.engine.start.voltage', value: 12.6 }])
})

test('does not publish a secondary battery without its optional ID', () => {
  const delta = measurementDelta({ id: 'house' }, {
    record_type: 0x02,
    measurements: {
      battery_voltage_v: 12.8,
      aux_input: 'aux_voltage',
      aux_voltage_v: 12.6
    }
  })

  assert.deepEqual(delta.updates[0].values, [
    { path: 'electrical.batteries.house.voltage', value: 12.8 }
  ])
})

test('does not map other BMV auxiliary modes to a secondary battery', () => {
  const delta = measurementDelta({ id: 'house', secondaryBattery: 'starter' }, {
    record_type: 0x02,
    measurements: {
      aux_input: 'temperature',
      aux_voltage_v: 12.6,
      temperature_k: 295.15
    }
  })

  assert.deepEqual(delta.updates[0].values, [
    { path: 'electrical.batteries.house.temperature', value: 295.15 }
  ])
})

test('does not publish a secondary battery when auxiliary voltage is unavailable', () => {
  const delta = measurementDelta({ id: 'house', secondaryBattery: 'starter' }, {
    record_type: 0x02,
    measurements: {
      aux_input: 'aux_voltage',
      aux_voltage_v: null
    }
  })

  assert.deepEqual(delta.updates[0].values, [])
})
