'use strict'

const { CONFIG_SCHEMA } = require('./lib/config-schema')
const { VictronConsumer } = require('./lib/consumer')
const { deviceRows } = require('./lib/device-list')
const { VictronDiscovery } = require('./lib/discovery')
const { tidy } = require('./lib/victron')

module.exports = function createPlugin(app) {
  let consumer = null
  let listener = null
  // Every Victron device heard, configured or not, identified from the
  // unencrypted parts of its advertisements. Kept across plugin restarts
  // (saving the configuration restarts the plugin) so the configuration panel
  // keeps showing what was heard.
  const discovery = new VictronDiscovery()
  let configured = []
  // Identity last published per device MAC, so it is sent only on change.
  let publishedIdentity = new Map()

  return {
    id: 'signalk-victron-ble-consumer',
    name: 'Signal K Victron BLE Consumer',
    description: 'Decodes configured Victron BLE advertisements server-side',

    // The admin UI shows the plugin's own panel (public/remoteEntry.js,
    // keyword signalk-plugin-configurator) instead of a generated form.
    schema: CONFIG_SCHEMA,

    start(settings = {}) {
      configured = Array.isArray(settings.devices) ? settings.devices : []
      consumer = new VictronConsumer(configured, Date.now, { advertisedNames: discovery.names })
      publishedIdentity = new Map()
      if (!app.bleApi || typeof app.bleApi.onAdvertisement !== 'function') {
        app.setPluginError(
          'Signal K BLE Provider API unavailable. This plugin requires a ' +
            'Signal K release containing BLE Provider API PR #2588.'
        )
        return
      }
      listener = advertisement => {
        discovery.observe(advertisement)
        const result = consumer.accept(advertisement)
        if (result && !result.state.decode_error && result.state.decoded) {
          const { device, state } = result
          const reception = { rssi: state.rssi, lastSeen: state.last_seen }
          this.publishIdentity(device, state.decoded)
          if (state.decoded.measurements) {
            app.handleMessage(this.id, measurementDelta(device, state.decoded, reception))
          }
        }
        const status = consumer.status()
        app.setPluginStatus(
          `Decoded ${status.decoded} Victron advertisements; ${status.errors} errors`
        )
      }
      listener = app.bleApi.onAdvertisement(this.id, listener)
      app.setPluginStatus(`Listening for ${consumer.status().devices.length} configured device(s)`)
    },

    publishIdentity(device, decoded) {
      const delta = identityDelta(device, decoded, discovery.names.get(device.mac) || null)
      const key = JSON.stringify(delta.updates[0].values)
      if (publishedIdentity.get(device.mac) === key) return
      publishedIdentity.set(device.mac, key)
      app.handleMessage(this.id, delta)
    },

    stop() {
      if (listener) listener()
      listener = null
      consumer = null
      app.setPluginStatus('Stopped')
    },

    registerWithRouter(router) {
      // Rows for the configuration panel: devices heard and configured, with
      // their decode state. Never includes advertisement keys. `running` says
      // whether the plugin is listening; a disabled plugin hears nothing.
      router.get('/devices', (_request, response) => {
        response.status(200).json({
          running: Boolean(listener),
          devices: deviceRows({
            discovered: discovery.list(),
            groupOf: deviceGroups,
            publishes: publishesReadings,
            configured,
            states: consumer ? consumer.status().devices : []
          })
        })
      })
      router.get('/status', (_request, response) => {
        response.status(200).json(consumer ? consumer.status() : {
          received: 0, decoded: 0, ignored: 0, errors: 0, devices: []
        })
      })
    }
  }
}

// Device state names as signalk-venus-plugin gives them, per Venus service.
// A state without a name is published as its number in text, as the plugin
// does. The DC-DC names (including "absorbtion" and "Ext Control" for 7) are
// the plugin's own, kept so both plugins send the same values.
const VENUS_STATES = {
  solarcharger: {
    0: 'not charging',
    2: 'other',
    3: 'bulk',
    4: 'absorption',
    5: 'float',
    6: 'other',
    7: 'equalize',
    245: 'wake up',
    252: 'external control'
  },
  alternator: {
    0: 'off',
    1: 'bulk',
    2: 'fault',
    3: 'bulk',
    4: 'absorption',
    5: 'float',
    6: 'storage',
    7: 'equalize',
    252: 'external control'
  },
  dcdc: {
    0: 'off',
    1: 'bulk',
    2: 'absorbtion',
    5: 'float',
    6: 'storage',
    7: 'Ext Control',
    8: 'disabled',
    9: 'float',
    11: 'power supply'
  }
}

function venusState(service, state) {
  if (state == null) return null
  return VENUS_STATES[service][state] || String(state)
}

// A record type without an entry here publishes nothing. Falling back to a
// path builder written for a different device would emit measurements under
// paths that do not describe the device that sent them.
// Record 0x0b (Multi RS) decodes but publishes nothing: no path has been
// agreed for it, and inventing paths below an unrelated group would
// misdescribe the device. Their decoded values are visible in the
// status API and the web application.
// Each entry names the Signal K electrical group the device is published
// under, and `alsoGroups` any further groups its readings go to under the
// same ID. A DC energy meter's group depends on its monitor mode, which is
// encrypted, so `groupFor` names it from the decoded values; a DC-DC
// converter's depends on the role configured for it.
const PATH_BUILDERS = {
  0x01: { group: 'solar', build: solarChargerCandidates },
  0x02: { group: 'batteries', build: batteryMonitorCandidates },
  0x03: { group: 'inverters', build: inverterCandidates },
  0x04: { groupFor: dcDcGroup, build: dcDcConverterCandidates },
  0x05: { group: 'batteries', build: smartLithiumCandidates },
  0x06: { group: 'inverters', build: inverterRsCandidates },
  0x08: { group: 'chargers', build: acChargerCandidates },
  0x09: { group: 'switches', build: batteryProtectCandidates },
  0x0a: { group: 'batteries', build: lynxCandidates },
  0x0c: { group: 'inverters', alsoGroups: ['chargers'], build: veBusCandidates },
  0x0d: { groupFor: dcMeterGroup, build: dcMeterCandidates },
  0x0f: { groupFor: dcDcGroup, build: orionCandidates }
}

/**
 * Signal K group of a device, for example `electrical.batteries`, or null for
 * a record type that publishes nothing or a DC energy meter not yet decoded.
 */
function deviceGroup(recordType, values, device) {
  return deviceGroups(recordType, values, device)[0] || null
}

/**
 * Venus service of a DC-DC converter or Orion XS: `dcdc`, or `alternator`
 * for one configured with the role `alternator` (charging from the engine's
 * alternator), as a GX device can show an Orion either way. The
 * advertisement does not carry the role, so it is configured per device.
 */
function dcDcGroup(_values, device) {
  return device && device.role === 'alternator' ? 'alternator' : 'dcdc'
}

/** Whether a record type publishes readings once its device has a path. */
function publishesReadings(recordType) {
  return Boolean(PATH_BUILDERS[recordType])
}

// Venus OS service a SmartShunt or BMV in DC energy meter mode becomes, by
// monitor mode, as the GX device and gui-v2 classify it. signalk-venus-plugin
// publishes each service as electrical.<service>, except solarcharger, which
// it publishes as electrical.solar.
//   -9 solar charger   -8 wind charger    -7 shaft generator  -6 alternator
//   -5 fuel cell       -4 water generator -3 DC/DC charger    -2 AC charger
//   -1 generic source   1 generic load     2 electric drive    3 fridge
//    4 water pump       5 bilge pump       6 DC system         7 inverter
//    8 water heater
const DC_METER_GROUPS = {
  [-9]: 'solar',
  [-6]: 'alternator',
  [-5]: 'fuelcell',
  2: 'motordrive',
  6: 'dcsystem'
}

/**
 * Group of a DC energy meter from its monitor mode: any other source mode is
 * a dcsource, any other load mode a dcload. Null before it has decoded.
 */
function dcMeterGroup(values) {
  const mode = values ? values.bmv_monitor_mode : null
  if (mode == null || mode === 0) return null
  return DC_METER_GROUPS[mode] || (mode < 0 ? 'dcsource' : 'dcload')
}

/**
 * Every Signal K group a device publishes under, its own group first: one
 * for most devices, `electrical.inverters` and `electrical.chargers` for a
 * VE.Bus inverter/charger. Empty for a record
 * type that publishes nothing.
 */
function deviceGroups(recordType, values, device) {
  const builder = PATH_BUILDERS[recordType]
  if (!builder) return []
  const group = builder.groupFor ? builder.groupFor(values, device) : builder.group
  if (!group) return []
  return [group, ...(builder.alsoGroups || [])].map(name => `electrical.${name}`)
}

/**
 * A configured path below a group: one or more dot-separated segments, such
 * as `1` or `1.lithium.2`. A leading dot is allowed and ignored.
 */
function relativePath(value) {
  return typeof value === 'string' ? value.trim().replace(/^\./, '') : ''
}

/**
 * Signal K base path of a device's readings, its group followed by its
 * configured `id`: `electrical.batteries.1`, or with the ID `1.lithium.2`,
 * `electrical.batteries.1.lithium.2` for a battery that is part of bank 1.
 * Null for a record type that publishes nothing, or a device without an ID.
 */
function devicePath(device, recordType, values) {
  const group = deviceGroup(recordType, values, device)
  const id = relativePath(device.id)
  return group && id ? `${group}.${id}` : null
}

/**
 * Base paths of a device in each of its groups, keyed by group name without
 * the `electrical.` prefix, e.g. `{ inverters: 'electrical.inverters.1',
 * chargers: 'electrical.chargers.1' }`. Empty without an ID.
 */
function devicePaths(device, recordType, values) {
  const id = relativePath(device.id)
  if (!id) return {}
  return Object.fromEntries(deviceGroups(recordType, values, device)
    .map(group => [group.slice('electrical.'.length), `${group}.${id}`]))
}

/**
 * Base path of the battery a BMV/SmartShunt's auxiliary voltage is published
 * to: `electrical.batteries.<secondaryBattery>`.
 */
function secondaryBatteryPath(value) {
  const id = relativePath(value)
  return id ? `electrical.batteries.${id}` : null
}

/**
 * Source of the device's deltas, shown by Signal K as
 * `signalk-victron-ble-consumer.<name>`: the display name, or the MAC when
 * none is set.
 */
function sourceOf(device) {
  const name = typeof device.name === 'string' ? device.name.trim() : ''
  return { label: 'Victron BLE', src: name || device.mac }
}

/**
 * The `dataType` and `instance` linking `sensors.<MAC>` to the device's
 * readings, so that `<dataType>.<instance>` is always its base path: the
 * path split at its last segment.
 */
function dataLink(base) {
  const split = base.lastIndexOf('.')
  return { dataType: base.slice(0, split), instance: base.slice(split + 1) }
}

/**
 * Signal K path of the sensor itself: `sensors.<MAC>`, the MAC written with
 * dashes, for example `sensors.D5-9E-F7-D6-F6-92`. Keyed by MAC rather than
 * configured ID or name so it is stable across renames and cannot collide
 * with another plugin's sensors.
 */
function sensorPath(device) {
  return `sensors.${String(device.mac).trim().toUpperCase().replace(/:/g, '-')}`
}

/**
 * Measurement delta for one decoded advertisement.
 *
 * `reception` carries the advertisement's RSSI (dBm) and the time it was
 * decoded. They describe the BLE link, not the measured item, so they are
 * published below the sensor as `RSSI` and `lastSeen`.
 */
function measurementDelta(device, decoded, reception = {}) {
  const values = decoded.measurements
  const base = devicePath(device, decoded.record_type, values)
  const paths = devicePaths(device, decoded.record_type, values)
  const candidates = base ? PATH_BUILDERS[decoded.record_type].build(base, values, paths, device) : []
  // The item's name goes with every reading, not only when it changes:
  // Signal K's source priorities hand a path to a lower-ranked source once
  // the preferred one has been silent for the fallback time (15 s by
  // default), so a name sent once would be taken over by any other source
  // that keeps repeating it.
  for (const path of Object.values(paths)) candidates.push([`${path}.name`, device.name || device.mac])
  if (device.mac) {
    const sensor = sensorPath(device)
    candidates.push(
      [`${sensor}.RSSI`, reception.rssi],
      [`${sensor}.lastSeen`, reception.lastSeen]
    )
  }

  // A BMV/SmartShunt can advertise its auxiliary input as a starter battery
  // voltage. When configured, expose that reading as a separate Signal K
  // battery so existing consumers can use the standard battery voltage path.
  const secondary = secondaryBatteryPath(device.secondaryBattery)
  if (
    decoded.record_type === 0x02 &&
    secondary &&
    values.aux_input === 'aux_voltage' &&
    values.aux_voltage_v != null
  ) {
    candidates.push([`${secondary}.voltage`, values.aux_voltage_v])
  }

  return {
    updates: [{
      source: sourceOf(device),
      timestamp: new Date().toISOString(),
      values: candidates
        .filter(([, value]) => value != null)
        .map(([path, value]) => ({ path, value: tidy(value) }))
    }]
  }
}

// Signal K models solar controllers under electrical.solar, which carries
// exact leaves for every MPPT advertisement field. The state is published as
// signalk-venus-plugin publishes it: controllerMode with the plugin's state
// name, and controllerModeNumber. The error code, which the plugin raises as
// a notification, stays in the status API.
function solarChargerCandidates(base, values) {
  return [
    [`${base}.voltage`, values.battery_voltage_v],
    [`${base}.current`, values.battery_charging_current_a],
    [`${base}.panelPower`, values.solar_power_w],
    [`${base}.yieldToday`, values.yield_today_j],
    [`${base}.loadCurrent`, values.external_device_load_a],
    [`${base}.controllerMode`, venusState('solarcharger', values.charge_state_number)],
    [`${base}.controllerModeNumber`, values.charge_state_number]
  ]
}

// DC-DC converters and Orion XS chargers are published as
// signalk-venus-plugin publishes a com.victronenergy.dcdc service, or a
// com.victronenergy.alternator one for a device with the role `alternator`:
// under electrical.dcdc or electrical.alternator, output as voltage and
// current, source side as input.voltage and input.current, and the state as
// the plugin's name for that service (chargingMode) and number. The error
// code stays in the status API.
function dcDcState(base, values, device) {
  return [
    [`${base}.chargingMode`, venusState(dcDcGroup(values, device), values.state)],
    [`${base}.chargingModeNumber`, values.state]
  ]
}

function dcDcConverterCandidates(base, values, _paths, device) {
  return [
    [`${base}.voltage`, values.output_voltage_v],
    [`${base}.input.voltage`, values.input_voltage_v],
    ...dcDcState(base, values, device)
  ]
}

// SmartShunt and BMV. Signal K states of charge are ratios and charge is in
// coulombs, so the advertised percentage and amp-hours are converted.
// Consumed Ah is published as signalk-venus-plugin publishes it, as
// capacity.consumedCharge with Venus's sign (negative while discharged).
function batteryMonitorCandidates(base, values) {
  return [
    [`${base}.voltage`, values.battery_voltage_v],
    [`${base}.current`, values.battery_current_a],
    [`${base}.capacity.stateOfCharge`, values.state_of_charge_percent == null
      ? null : values.state_of_charge_percent / 100],
    [`${base}.capacity.timeRemaining`, values.time_to_go_s],
    [`${base}.capacity.consumedCharge`, consumedCharge(values)],
    // The aux temperature is advertised in 0.01 K, which is already the
    // Signal K unit, so it passes through unconverted.
    [`${base}.temperature`, values.temperature_k]
    // The starter and mid-point voltages have no Signal K leaf. They stay in
    // the status API rather than being invented below `voltage`, which the
    // schema defines as a value leaf with only `ripple` beneath it.
  ]
}

// SmartLithium reports pack voltage, temperature, per-cell voltages and the
// balancer status. Signal K defines no cell or balancer leaves; they use the
// paths bt-sensors-plugin-sk publishes for the same battery
// (cell<N>.voltage, balancerStatus), so the two plugins agree. Cells the
// battery does not have (a 12.8 V pack has 4 of 8) are reported unavailable
// and left out. A cell beyond the measurable range (below 2.61 V or above
// 3.85 V) is published at that bound.
function smartLithiumCandidates(base, values) {
  const cells = (values.cell_voltages_v || []).map((cell, index) =>
    [`${base}.cell${index + 1}.voltage`, cell ? cell.voltage_v : null])
  return [
    [`${base}.voltage`, values.battery_voltage_v == null
      ? null : Math.round(values.battery_voltage_v * 100) / 100],
    [`${base}.temperature`, values.temperature_c == null
      ? null : values.temperature_c + 273.15],
    ...cells,
    [`${base}.balancerStatus`, values.balancer_status_name]
  ]
}

// Metadata for the SmartLithium leaves Signal K does not define, sent with
// the device's identity
function smartLithiumMeta(base, values) {
  const cells = (values.cell_voltages_v || []).flatMap((cell, index) => cell ? [{
    path: `${base}.cell${index + 1}.voltage`,
    value: { units: 'V', description: `Voltage of cell ${index + 1}` }
  }] : [])
  return [...cells, {
    path: `${base}.balancerStatus`,
    value: { description: 'Cell balancer status: balanced, balancing, imbalance or unknown' }
  }]
}

function inverterCandidates(base, values) {
  return [
    [`${base}.dc.voltage`, values.battery_voltage_v],
    [`${base}.ac.lineNeutralVoltage`, values.ac_voltage_v],
    [`${base}.ac.current`, values.ac_current_a],
    [`${base}.ac.apparentPower`, values.ac_apparent_power_va]
  ]
}

function inverterRsCandidates(base, values) {
  return [
    [`${base}.dc.voltage`, values.battery_voltage_v],
    [`${base}.dc.current`, values.battery_current_a],
    [`${base}.ac.realPower`, values.ac_out_power_w]
  ]
}

function consumedCharge(values) {
  return values.consumed_ah == null ? null : values.consumed_ah * 3600
}

// A SmartShunt or BMV set up as a DC energy meter is published as
// signalk-venus-plugin publishes the Venus service it becomes (see
// DC_METER_GROUPS): voltage, current and power, the temperature or starter
// voltage the aux input measures (the second as <path>-second.voltage, as
// for /Dc/1/Voltage), all below the group its monitor mode selects. Power is
// voltage times current, as the GX computes it.
function dcMeterCandidates(base, values) {
  const power = values.battery_voltage_v == null || values.battery_current_a == null
    ? null : values.battery_voltage_v * values.battery_current_a
  return [
    [`${base}.voltage`, values.battery_voltage_v],
    [`${base}.current`, values.battery_current_a],
    [`${base}.power`, power == null ? null : Math.round(power * 100) / 100],
    [`${base}.temperature`, values.temperature_k],
    [`${base}-second.voltage`, values.aux_voltage_v]
  ]
}

function lynxCandidates(base, values) {
  return [
    [`${base}.voltage`, values.battery_voltage_v],
    [`${base}.current`, values.battery_current_a],
    [`${base}.capacity.stateOfCharge`, values.state_of_charge_percent == null
      ? null : Math.round(values.state_of_charge_percent * 10) / 1000],
    [`${base}.capacity.timeRemaining`, values.time_to_go_s],
    [`${base}.capacity.consumedCharge`, consumedCharge(values)],
    [`${base}.temperature`, values.temperature_c == null ? null : values.temperature_c + 273.15]
  ]
}

function orionCandidates(base, values, _paths, device) {
  return [
    [`${base}.voltage`, values.output_voltage_v],
    [`${base}.current`, values.output_current_a],
    [`${base}.input.voltage`, values.input_voltage_v],
    [`${base}.input.current`, values.input_current_a],
    ...dcDcState(base, values, device)
  ]
}

// A Smart BatteryProtect is a DC load switch, so it is published under
// electrical.switches, where signalk-venus-plugin publishes a GX device's
// switchable outputs: state as a boolean (true when the output is on), plus
// its output and input voltages. Neither Signal K nor the venus plugin knows
// a BatteryProtect, so deviceState (e.g. active, off) and offReason (e.g.
// remote_input, or none) are this plugin's own leaves.
const OUTPUT_ON = 1
const OUTPUT_OFF = 0

function batteryProtectCandidates(base, values) {
  const output = values.output_state
  return [
    [`${base}.state`, output === OUTPUT_ON ? true : output === OUTPUT_OFF ? false : null],
    [`${base}.voltage`, values.output_voltage_v],
    [`${base}.input.voltage`, values.input_voltage_v],
    [`${base}.deviceState`, values.state_name],
    [`${base}.offReason`, offReasonText(values)]
  ]
}

function offReasonText(values) {
  if (values.off_reason == null) return null
  if (values.off_reasons && values.off_reasons.length) return values.off_reasons.join(', ')
  return values.off_reason === 0 ? 'none' : `unknown_0x${values.off_reason.toString(16)}`
}

// Metadata for the BatteryProtect leaves, sent with the device's identity
function batteryProtectMeta(base) {
  return [
    { path: `${base}.state`, value: { units: 'bool', description: 'Output on (true) or off (false)' } },
    { path: `${base}.input.voltage`, value: { units: 'V', description: 'Input (battery side) voltage' } },
    { path: `${base}.deviceState`, value: { description: 'Device state, e.g. active or off' } },
    { path: `${base}.offReason`, value: { description: 'Why the output is off, e.g. remote_input; none when on' } }
  ]
}

// AC charger states as signalk-venus-plugin names them for a
// com.victronenergy.charger service.
const AC_CHARGER_STATES = {
  0: 'off',
  1: 'low power mode',
  2: 'fault',
  3: 'bulk',
  4: 'absorption',
  5: 'float',
  6: 'storage',
  7: 'equalize',
  8: 'passthru',
  9: 'inverting',
  10: 'power assist',
  11: 'power supply',
  252: 'bulk protection'
}
// Path suffixes signalk-venus-plugin gives a charger's second and third
// outputs: electrical.chargers.<id>-second and <id>-third.
const AC_CHARGER_OUTPUT_SUFFIXES = ['', '-second', '-third']

// A Phoenix Smart or Blue Smart IP charger is published as
// signalk-venus-plugin publishes it from a GX device: each output's voltage
// and current, the first under the charger's path and the others under
// <path>-second and <path>-third, then its temperature, AC input current and
// state, as the plugin's state name (chargingMode) and number. The error
// code, which the plugin raises as a notification, stays in the status API.
function acChargerCandidates(base, values) {
  const outputs = (values.outputs || []).flatMap((output, index) => [
    [`${base}${AC_CHARGER_OUTPUT_SUFFIXES[index]}.voltage`, output.voltage_v],
    [`${base}${AC_CHARGER_OUTPUT_SUFFIXES[index]}.current`, output.current_a]
  ])
  const state = values.state
  return [
    ...outputs,
    [`${base}.temperature`, values.temperature_c == null ? null : values.temperature_c + 273.15],
    [`${base}.acin.1.current`, values.ac_current_a],
    [`${base}.chargingMode`, state == null ? null : (AC_CHARGER_STATES[state] || String(state))],
    [`${base}.chargingModeNumber`, state]
  ]
}

// VE.Bus device states as signalk-venus-plugin names them for a
// com.victronenergy.vebus service.
const VEBUS_STATES = {
  0: 'off',
  1: 'low power',
  2: 'fault',
  3: 'bulk',
  4: 'absorption',
  5: 'float',
  6: 'storage',
  7: 'equalize',
  8: 'passthru',
  9: 'inverting',
  10: 'power assist',
  11: 'power supply',
  244: 'sustain',
  245: 'wake up',
  252: 'external control'
}
const VEBUS_STATE_UNAVAILABLE = 0xff

// A MultiPlus or Quattro (VE.Bus) is published as signalk-venus-plugin
// publishes it from a GX device, so the BLE readings and the GX's line up
// path for path and can be ranked against each other: the DC side and the
// state under chargers, the AC side and the state again under inverters.
// Like the venus plugin, nothing goes under batteries: the battery's own
// monitor publishes there. The state is published as the plugin does:
// its name as chargingMode and inverterMode, and its number alongside.
// The advertisement carries the active AC input's number but not its source
// type, the VE.Bus error and one combined alarm; the GX publishes these
// differently, so they stay in the status API.
function veBusCandidates(_base, values, { inverters, chargers }) {
  const state = values.state === VEBUS_STATE_UNAVAILABLE ? null : values.state
  const mode = state == null ? null : (VEBUS_STATES[state] || String(state))
  return [
    [`${chargers}.voltage`, values.battery_voltage_v == null
      ? null : Math.round(values.battery_voltage_v * 100) / 100],
    [`${chargers}.current`, values.battery_current_a == null
      ? null : Math.round(values.battery_current_a * 10) / 10],
    [`${chargers}.temperature`, values.temperature_c == null ? null : values.temperature_c + 273.15],
    [`${chargers}.capacity.stateOfCharge`, values.state_of_charge_percent == null
      ? null : values.state_of_charge_percent / 100],
    [`${chargers}.chargingMode`, mode],
    [`${chargers}.chargingModeNumber`, state],
    [`${inverters}.inverterMode`, mode],
    [`${inverters}.inverterModeNumber`, state],
    [`${inverters}.acin.power`, values.active_ac_power_w],
    [`${inverters}.acout.power`, values.ac_out_power_w]
  ]
}

const VICTRON_VENDOR = 'Victron Energy'

/**
 * Identity delta for a device.
 *
 * The sensor, `sensors.<MAC>`, carries what the Victron device is: `name`
 * (the configured display name), `sensorType` (the model named from the
 * advertised product ID, or the hex ID when the model is not in the table),
 * `vendor`, and `advertisedName` when the device broadcasts one. It also
 * links to the item its readings are published under, its base path split
 * at the last segment: `dataType` (for example `electrical.batteries`) and
 * `instance` (`2`), so `electrical.batteries.2` is `<dataType>.<instance>`.
 *
 * The measured item, at the base path, gets only its `name`: a
 * battery watched by a Smart Battery Sense or SmartShunt is not itself a
 * Victron product, so no manufacturer is claimed for it.
 */
function identityDelta(device, decoded, advertisedName) {
  const sensor = sensorPath(device)
  const base = devicePath(device, decoded.record_type, decoded.measurements)
  const link = base ? dataLink(base) : null
  const modelId = `0x${decoded.model_id.toString(16).toUpperCase().padStart(4, '0')}`
  const name = device.name || device.mac
  const values = [
    [`${sensor}.name`, name],
    [`${sensor}.sensorType`, decoded.model_name || modelId],
    [`${sensor}.vendor`, VICTRON_VENDOR],
    [`${sensor}.advertisedName`, advertisedName],
    ...(base ? [
      [`${sensor}.dataType`, link.dataType],
      [`${sensor}.instance`, link.instance],
      ...Object.values(devicePaths(device, decoded.record_type, decoded.measurements)).map(path => [`${path}.name`, name])
    ] : [])
  ]
  return {
    updates: [{
      source: sourceOf(device),
      timestamp: new Date().toISOString(),
      values: values
        .filter(([, value]) => value != null)
        .map(([path, value]) => ({ path, value })),
      meta: [
        { path: `${sensor}.RSSI`, value: { description: 'Signal strength of the last decoded BLE advertisement, in dBm' } },
        { path: `${sensor}.lastSeen`, value: { description: 'Time the last BLE advertisement was decoded (ISO 8601)' } },
        { path: `${sensor}.advertisedName`, value: { description: 'Local name the device advertises over BLE' } },
        { path: `${sensor}.dataType`, value: { description: 'Signal K group the sensor readings are published under' } },
        { path: `${sensor}.instance`, value: { description: 'Instance within dataType the sensor readings are published under' } },
        ...(base && decoded.record_type === 0x05 && decoded.measurements
          ? smartLithiumMeta(base, decoded.measurements) : []),
        ...(base && decoded.record_type === 0x09 ? batteryProtectMeta(base) : [])
      ]
    }]
  }
}

module.exports.identityDelta = identityDelta
module.exports.sensorPath = sensorPath
module.exports.measurementDelta = measurementDelta
