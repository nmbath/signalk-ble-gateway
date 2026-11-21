'use strict'

/**
 * JSON Schema of the plugin configuration.
 *
 * The admin UI shows the plugin's own configuration panel
 * (public/remoteEntry.js) instead of a form generated from this schema, so it
 * only describes the stored configuration, for validation and for clients
 * that do render it.
 */
const CONFIG_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    devices: {
      title: 'Victron devices',
      type: 'array',
      default: [],
      items: {
        type: 'object',
        required: ['id', 'name', 'mac', 'advertisementKey'],
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
          secondaryBattery: {
            title: 'Secondary battery ID',
            description: 'BMV/SmartShunt only: publish the auxiliary voltage as a separate Signal K battery',
            type: 'string'
          },
          enabled: { title: 'Enabled', type: 'boolean', default: true }
        }
      }
    }
  }
})

module.exports = { CONFIG_SCHEMA }
