'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { CONFIG_SCHEMA } = require('../lib/config-schema')

test('describes the stored device configuration', () => {
  const item = CONFIG_SCHEMA.properties.devices.items
  assert.deepEqual(item.required, ['id', 'name', 'mac', 'advertisementKey'])
  assert.deepEqual(Object.keys(item.properties),
    ['id', 'name', 'mac', 'advertisementKey', 'secondaryBattery', 'enabled'])
  assert.equal(CONFIG_SCHEMA.properties.discovered, undefined)
})
