'use strict'

const { isShuntBatteryMonitor, modelName } = require('./victron-models')

const NOT_DETECTED = 'Not detected yet. Reload this page once the device has been heard.'

const SECONDARY_BATTERY = {
  title: 'Secondary battery ID',
  description: 'Publish the BMV/SmartShunt auxiliary voltage as a separate Signal K battery',
  type: 'string'
}

/**
 * Build the plugin configuration schema.
 *
 * A device's type is only known once an advertisement from its MAC has been
 * decoded, so the schema is built from `detected`, what the plugin has
 * decoded so far. Each device row then shows, through a JSON Schema
 * dependency on its MAC field:
 * - a description naming the detected model, advertised name, RSSI and how
 *   long ago it was last decoded, as of the time the form was loaded;
 * - the secondary battery option, only for a BMV or SmartShunt.
 *
 * Hidden fields keep their saved value: the Signal K admin form does not omit
 * extra data, so a configured secondary battery survives a save made before
 * the device has been heard.
 *
 * @param {object[]} detected `{ mac, modelId, advertisedName, rssi, lastSeen }`
 *   per detected device, MAC normalized to upper case
 * @param {number} now current time in milliseconds, for "last seen"
 */
function buildSchema(detected = [], now = Date.now()) {
  const item = {
    type: 'object',
    required: ['id', 'name', 'mac', 'advertisementKey'],
    description: NOT_DETECTED,
    properties: {
      id: { title: 'Stable device ID', type: 'string' },
      name: { title: 'Display name', type: 'string' },
      mac: { title: 'BLE MAC address', type: 'string' },
      advertisementKey: {
        title: 'Victron advertisement key',
        type: 'string',
        minLength: 32,
        maxLength: 32
      },
      enabled: { title: 'Enabled', type: 'boolean', default: true }
    }
  }

  if (detected.length > 0) {
    item.dependencies = {
      mac: {
        oneOf: [
          ...detected.map(device => ({
            description: detectionSummary(device, now),
            properties: {
              mac: { pattern: macPattern([device.mac]) },
              ...(isShuntBatteryMonitor(device.modelId) ? { secondaryBattery: SECONDARY_BATTERY } : {})
            }
          })),
          {
            description: NOT_DETECTED,
            properties: { mac: { not: { pattern: macPattern(detected.map(device => device.mac)) } } }
          }
        ]
      }
    }
  }

  return {
    type: 'object',
    properties: {
      devices: {
        title: 'Victron devices',
        type: 'array',
        default: [],
        items: item
      }
    }
  }
}

/**
 * One line describing a detected device, for example
 * `Detected: Smart Battery Sense (Rev2) (0xA3A5) · advertised as "12v Bat 1" ·
 * RSSI -74 dBm · last seen 3 s ago`.
 */
function detectionSummary({ modelId, advertisedName, rssi, lastSeen }, now = Date.now()) {
  const id = `0x${modelId.toString(16).toUpperCase().padStart(4, '0')}`
  const parts = [`Detected: ${modelName(modelId) || 'Unknown Victron model'} (${id})`]
  if (advertisedName) parts.push(`advertised as "${advertisedName}"`)
  if (typeof rssi === 'number') parts.push(`RSSI ${rssi} dBm`)
  if (lastSeen) parts.push(`last seen ${ago(now - Date.parse(lastSeen))}`)
  return parts.join(' · ')
}

function ago(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  if (seconds < 60) return `${seconds} s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  return `${Math.round(seconds / 3600)} h ago`
}

/**
 * Match any of the given MAC addresses as typed in the form: surrounding
 * whitespace and either letter case, as the consumer normalizes both.
 * JSON Schema patterns take no flags, so case is spelled out per character.
 */
function macPattern(macs) {
  const alternatives = macs.map(mac => [...mac].map(character => {
    if (/[A-F]/i.test(character)) return `[${character.toLowerCase()}${character.toUpperCase()}]`
    // Escape only regex syntax: the admin form compiles patterns in Unicode
    // mode, where an identity escape such as \: is a syntax error.
    return character.replace(/[\^$\\.*+?()[\]{}|/]/g, symbol => `\\${symbol}`)
  }).join(''))
  return `^\\s*(?:${alternatives.join('|')})\\s*$`
}

module.exports = { buildSchema, detectionSummary, macPattern }
