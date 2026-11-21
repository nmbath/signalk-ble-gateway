'use strict'

const { RECORD_TYPES } = require('./victron')
const { isShuntBatteryMonitor, modelName } = require('./victron-models')

// Devices not heard for this long are left out unless they are configured.
const HEARD_WINDOW_MS = 15 * 60 * 1000
const BATTERY_MONITOR_RECORD = 0x02

function normalizeMac(value) {
  return String(value || '').trim().toUpperCase()
}

/**
 * Rows for the configuration panel: every Victron device heard recently,
 * plus every configured device, heard or not.
 *
 * Each row joins what was heard without a key (product ID, record type,
 * advertised name, RSSI, when) with the device's configuration and its
 * decode state. Advertisement keys are never included: the panel already
 * holds the configuration it edits.
 *
 * Configured devices come first, then the strongest signal first, so the
 * boat's own devices sort above a neighbour's.
 *
 * @param {object} options
 * @param {object[]} options.discovered from VictronDiscovery.list()
 * @param {object[]} options.configured the configured devices
 * @param {object[]} options.states VictronConsumer.status().devices
 * @param {function} options.groupOf record type -> Signal K group the device
 *   publishes under (e.g. `electrical.batteries`), or null
 * @param {number} now current time in milliseconds
 */
function deviceRows({ discovered = [], configured = [], states = [], groupOf = () => null } = {}, now = Date.now()) {
  const heard = new Map(discovered.map(device => [device.mac, device]))
  const stateByMac = new Map(states.map(state => [normalizeMac(state.mac), state]))
  const rows = new Map()

  for (const device of discovered) {
    if (now - Date.parse(device.lastSeen) > HEARD_WINDOW_MS) continue
    rows.set(device.mac, heardRow(device, groupOf))
  }
  for (const device of configured) {
    const mac = normalizeMac(device && device.mac)
    if (!mac) continue
    const seen = heard.get(mac)
    const state = stateByMac.get(mac) || {}
    rows.set(mac, {
      ...(seen ? heardRow(seen, groupOf) : emptyRow(mac)),
      configured: true,
      deviceId: device.id || null,
      displayName: device.name || null,
      enabled: device.enabled !== false,
      online: state.online === true,
      decodeError: state.decode_error || null
    })
  }

  return [...rows.values()].sort((a, b) =>
    Number(b.configured) - Number(a.configured) ||
    (b.rssi ?? -Infinity) - (a.rssi ?? -Infinity) ||
    a.mac.localeCompare(b.mac))
}

function heardRow(device, groupOf) {
  return {
    group: groupOf(device.recordType) || null,
    mac: device.mac,
    modelId: device.modelId,
    modelName: modelName(device.modelId),
    recordName: RECORD_TYPES[device.recordType] || null,
    advertisedName: device.advertisedName || null,
    rssi: typeof device.rssi === 'number' ? device.rssi : null,
    lastSeen: device.lastSeen,
    // Only the battery monitor record carries the auxiliary (starter) voltage;
    // a shunt set up as a DC energy meter sends the DC meter record instead.
    supportsSecondaryBattery: device.recordType === BATTERY_MONITOR_RECORD && isShuntBatteryMonitor(device.modelId),
    configured: false
  }
}

function emptyRow(mac) {
  return {
    group: null,
    mac,
    modelId: null,
    modelName: null,
    recordName: null,
    advertisedName: null,
    rssi: null,
    lastSeen: null,
    supportsSecondaryBattery: false,
    configured: false
  }
}

module.exports = { HEARD_WINDOW_MS, deviceRows }
