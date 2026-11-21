'use strict'

const { readClearHeader } = require('./victron')

const DEFAULT_MAX_ENTRIES = 256

function normalizeMac(value) {
  return String(value || '').trim().toUpperCase()
}

/**
 * Remembers every Victron device heard, configured or not, from the parts of
 * its advertisements that need no key: the Instant Readout header (product ID
 * and record type), the advertised local name, RSSI and when it was heard.
 *
 * Both maps are bounded: once full, the device heard least recently is
 * dropped, so passing boats in a marina cannot grow them without limit.
 */
class VictronDiscovery {
  /**
   * @param {object} options
   * @param {number} options.maxEntries most devices (and names) remembered
   */
  constructor({ maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    this.maxEntries = maxEntries
    this.devices = new Map()
    // Advertised names per MAC. A name can arrive in a packet without
    // Instant Readout data, so names are kept for any MAC, not only devices
    // already identified as Victron.
    this.names = new Map()
  }

  /**
   * Record what an advertisement reveals without decryption.
   * @returns {object|null} the device entry when it is a Victron device
   */
  observe(advertisement, now = Date.now()) {
    const mac = normalizeMac(advertisement?.mac)
    if (!mac) return null

    const name = typeof advertisement.name === 'string' ? advertisement.name.trim() : ''
    if (name) remember(this.names, mac, name, this.maxEntries)

    let header
    try {
      header = readClearHeader(advertisement)
    } catch {
      return null
    }
    if (!header) return this.devices.get(mac) || null

    const entry = {
      mac,
      modelId: header.modelId,
      recordType: header.recordType,
      rssi: typeof advertisement.rssi === 'number' ? advertisement.rssi : null,
      lastSeen: new Date(now).toISOString()
    }
    remember(this.devices, mac, entry, this.maxEntries)
    return entry
  }

  /** The device heard under this MAC, with its advertised name, or null. */
  get(mac) {
    const key = normalizeMac(mac)
    const entry = this.devices.get(key)
    return entry ? { ...entry, advertisedName: this.names.get(key) || null } : null
  }

  /** Every Victron device heard, with its advertised name. */
  list() {
    return [...this.devices.keys()].map(mac => this.get(mac))
  }
}

// Re-inserting moves a key to the end of the Map's order, so the first key is
// always the least recently heard and is the one evicted.
function remember(map, key, value, maxEntries) {
  map.delete(key)
  map.set(key, value)
  if (map.size > maxEntries) map.delete(map.keys().next().value)
}

module.exports = { VictronDiscovery }
