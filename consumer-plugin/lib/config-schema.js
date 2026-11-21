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
          id: {
            title: 'Signal K path',
            description: 'Path below the device\'s group: 1 for electrical.batteries.1, 1.lithium.2 for electrical.batteries.1.lithium.2',
            type: 'string',
            pattern: '^\\.?[A-Za-z0-9_-]+(\\.[A-Za-z0-9_-]+)*$'
          },
          name: {
            title: 'Display name',
            description: 'Unique; also the source of the device\'s data, signalk-victron-ble-consumer.<name>',
            type: 'string'
          },
          mac: { title: 'BLE MAC address', type: 'string' },
          advertisementKey: {
            title: 'Victron advertisement key',
            type: 'string',
            minLength: 32,
            maxLength: 32
          },
          secondaryBattery: {
            title: 'Secondary battery path',
            description: 'BMV/SmartShunt only: publish the auxiliary voltage as electrical.batteries.<path>',
            type: 'string'
          },
          enabled: { title: 'Enabled', type: 'boolean', default: true }
        }
      }
    }
  }
})

module.exports = { CONFIG_SCHEMA }
