/*
 * Configuration panel for the Signal K admin UI.
 *
 * Signal K shows this in place of a form generated from the plugin schema,
 * because package.json carries the keyword signalk-plugin-configurator. The
 * admin UI loads this file as a classic Module Federation remote: it reads
 * the container from window.signalk_victron_ble_consumer, calls init() with
 * its shared scope, which provides the admin UI's own React, and renders
 * get('./PluginConfigurationPanel') with { configuration, save }.
 *
 * Written by hand, without a bundler, so the plugin needs no build step and
 * no runtime dependencies: React comes from the admin UI. The helpers at the
 * top are plain functions, exported for the unit tests when this file is
 * loaded by Node.
 */
;(function (root) {
  'use strict'

  var PLUGIN_ID = 'signalk-victron-ble-consumer'
  var DEVICES_URL = '/plugins/' + PLUGIN_ID + '/devices'
  var PANEL_MODULE = './PluginConfigurationPanel'
  var REFRESH_MS = 5000
  // Same thresholds and wording as the admin UI's BLE Manager
  var RSSI_STRONG_DBM = -50
  var RSSI_GOOD_DBM = -70
  var RSSI_FAIR_DBM = -85
  var JUST_NOW_MAX_S = 5
  var KEY_PATTERN = /^[0-9a-fA-F]{32}$/
  // A device ID becomes one Signal K path segment, e.g. electrical.batteries.<id>
  var ID_PATTERN = /^[A-Za-z0-9_-]+$/
  var LIST_MAX_HEIGHT = '320px'
  // The longest name one advertisement can carry: 31 bytes, less the 2-byte
  // AD header. Devices with longer names send them shortened to fit.
  var ADVERTISED_NAME_MAX_BYTES = 29
  var CONFIGURED_TAB = 'configured'
  // Tabs by kind of device, from the record type it advertises, like the
  // domain tabs of bt-sensors-plugin-sk. Converters holds everything that
  // turns one source of power into another: solar chargers, DC-DC chargers
  // (Orion TR, Orion XS), AC battery chargers, inverters and inverter/chargers.
  var TYPE_TABS = [
    { key: 'batteries', title: 'Batteries', records: ['battery_monitor', 'smart_lithium', 'lynx_smart_bms'] },
    {
      key: 'converters',
      title: 'Converters',
      records: ['solar_charger', 'dc_dc_converter', 'orion_xs', 'ac_charger',
        'inverter', 'inverter_rs', 'multi_rs', 've_bus']
    },
    { key: 'battery-protect', title: 'Smart BatteryProtect', records: ['battery_protect'] },
    { key: 'dc-energy-meters', title: 'DC Energy Meters', records: ['dc_energy_meter'] },
    { key: 'other', title: 'Other', records: null }
  ]

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function normalizeMac(value) {
    return String(value || '').trim().toUpperCase()
  }

  function rssiColor(rssi) {
    if (rssi >= RSSI_STRONG_DBM) return 'success'
    if (rssi >= RSSI_GOOD_DBM) return 'primary'
    if (rssi >= RSSI_FAIR_DBM) return 'warning'
    return 'danger'
  }

  function formatAge(lastSeen, now) {
    if (!lastSeen) return '-'
    var seconds = Math.max(0, Math.round((now - Date.parse(lastSeen)) / 1000))
    if (seconds < JUST_NOW_MAX_S) return 'just now'
    if (seconds < 60) return seconds + 's ago'
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago'
    return Math.floor(seconds / 3600) + 'h ago'
  }

  function hexId(modelId) {
    return '0x' + modelId.toString(16).toUpperCase().padStart(4, '0')
  }

  function typeLabel(row) {
    if (row.modelName) return row.modelName
    if (row.modelId !== null && row.modelId !== undefined) return 'Unknown Victron model (' + hexId(row.modelId) + ')'
    return '-'
  }

  /** Status of a configured device, or null for one that is not configured. */
  function statusOf(row) {
    if (!row.configured) return null
    if (row.enabled === false) return { label: 'Disabled', color: 'secondary' }
    if (row.decodeError && /key check/i.test(row.decodeError)) return { label: 'Wrong key', color: 'danger' }
    if (row.decodeError) return { label: 'Error', color: 'danger' }
    if (row.online) return { label: 'Online', color: 'success' }
    if (!row.lastSeen) return { label: 'Not heard', color: 'secondary' }
    return { label: 'Waiting', color: 'warning' }
  }

  /** The type tab a device belongs to, or null when its type is unknown. */
  function typeTabOf(row) {
    if (!row.recordName) return null
    for (var i = 0; i < TYPE_TABS.length; i += 1) {
      var tab = TYPE_TABS[i]
      if (tab.records === null || tab.records.indexOf(row.recordName) >= 0) return tab.key
    }
    return null
  }

  /**
   * The tabs to show: Configured first, then each type tab that has devices,
   * each with the rows it lists.
   */
  function tabsFor(rows) {
    var tabs = [{
      key: CONFIGURED_TAB,
      title: 'Configured',
      rows: rows.filter(function (row) { return row.configured })
    }]
    TYPE_TABS.forEach(function (tab) {
      var tabRows = rows.filter(function (row) { return typeTabOf(row) === tab.key })
      if (tabRows.length > 0) tabs.push({ key: tab.key, title: tab.title, rows: tabRows })
    })
    return tabs
  }

  function configuredDevices(configuration) {
    var devices = configuration && Array.isArray(configuration.devices) ? configuration.devices : []
    return devices.filter(function (device) { return device && device.mac })
  }

  /**
   * Join the server's rows with the configuration being edited. The panel's
   * configuration is the source of truth for what is configured, since it may
   * differ from what the running plugin was started with.
   */
  function mergeRows(serverRows, configuration) {
    var devices = configuredDevices(configuration)
    var byMac = new Map()
    ;(serverRows || []).forEach(function (row) {
      byMac.set(row.mac, Object.assign({}, row, { configured: false }))
    })
    devices.forEach(function (device) {
      var mac = normalizeMac(device.mac)
      var row = byMac.get(mac) || {
        mac: mac, modelId: null, modelName: null, advertisedName: null,
        rssi: null, lastSeen: null, supportsSecondaryBattery: false
      }
      byMac.set(mac, Object.assign({}, row, {
        configured: true,
        deviceId: device.id || null,
        displayName: device.name || null,
        enabled: device.enabled !== false
      }))
    })
    return Array.from(byMac.values()).sort(compareRows)
  }

  // Natural order, so "Battery 2" sorts before "Battery 10"
  var NAME_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

  function tabIndexOf(row) {
    var key = typeTabOf(row)
    var index = TYPE_TABS.findIndex(function (tab) { return tab.key === key })
    return index < 0 ? TYPE_TABS.length : index
  }

  /**
   * The name to list a device by: the name configured for it, which the user
   * can correct, otherwise the name it advertises.
   */
  function nameOf(row) {
    return (row.configured && row.displayName) || row.advertisedName || ''
  }

  /** Whether an advertised name fills a whole advertisement, so may be cut short. */
  function mayBeShortened(name) {
    return typeof name === 'string' && new TextEncoder().encode(name).length >= ADVERTISED_NAME_MAX_BYTES
  }

  /**
   * A fixed order that does not change as signal strength and last seen do:
   * by type tab, then name, with unnamed devices last, then MAC address.
   */
  function compareRows(a, b) {
    var nameA = nameOf(a)
    var nameB = nameOf(b)
    return (tabIndexOf(a) - tabIndexOf(b)) ||
      (Number(!nameA) - Number(!nameB)) ||
      NAME_ORDER.compare(nameA, nameB) ||
      a.mac.localeCompare(b.mac)
  }

  /** The editable fields for a row: its configuration, or a new device. */
  function draftFor(row, configuration) {
    var existing = configuredDevices(configuration).find(function (device) {
      return normalizeMac(device.mac) === row.mac
    })
    if (existing) {
      return {
        isNew: false,
        mac: row.mac,
        name: existing.name || '',
        id: existing.id || '',
        advertisementKey: existing.advertisementKey || '',
        enabled: existing.enabled !== false,
        secondaryBattery: existing.secondaryBattery || ''
      }
    }
    return {
      isNew: true,
      mac: row.mac,
      name: row.advertisedName || row.modelName || '',
      id: '',
      advertisementKey: '',
      enabled: true,
      secondaryBattery: ''
    }
  }

  /** Field errors of a draft, keyed by field; empty when it can be saved. */
  function validate(draft, configuration) {
    var errors = {}
    var others = configuredDevices(configuration).filter(function (device) {
      return normalizeMac(device.mac) !== draft.mac
    })
    var id = draft.id.trim()
    if (!draft.name.trim()) errors.name = 'Enter a display name.'
    if (!id) {
      errors.id = 'Enter an ID.'
    } else if (!ID_PATTERN.test(id)) {
      errors.id = 'Use letters, digits, - or _ only.'
    } else if (others.some(function (device) { return device.id === id })) {
      errors.id = 'Another device already uses this ID.'
    }
    if (!KEY_PATTERN.test(draft.advertisementKey.trim())) {
      errors.advertisementKey = 'The key is 32 hexadecimal characters.'
    }
    var secondary = draft.secondaryBattery.trim()
    if (secondary && !ID_PATTERN.test(secondary)) {
      errors.secondaryBattery = 'Use letters, digits, - or _ only.'
    } else if (secondary && secondary === id) {
      errors.secondaryBattery = 'Must differ from the device ID.'
    }
    return errors
  }

  /**
   * The configuration with the draft added or updated. Other settings and
   * any unknown fields of the device are kept; the display-only `discovered`
   * entry an earlier version stored is dropped.
   */
  function applyDraft(configuration, draft) {
    var devices = configuredDevices(configuration)
    var index = devices.findIndex(function (device) { return normalizeMac(device.mac) === draft.mac })
    var device = Object.assign({}, index >= 0 ? devices[index] : {}, {
      id: draft.id.trim(),
      name: draft.name.trim(),
      mac: draft.mac,
      advertisementKey: draft.advertisementKey.trim().toLowerCase(),
      enabled: draft.enabled
    })
    if (draft.secondaryBattery.trim()) {
      device.secondaryBattery = draft.secondaryBattery.trim()
    } else {
      delete device.secondaryBattery
    }
    var next = devices.slice()
    if (index >= 0) next[index] = device
    else next.push(device)
    return withDevices(configuration, next)
  }

  function removeDevice(configuration, mac) {
    return withDevices(configuration, configuredDevices(configuration).filter(function (device) {
      return normalizeMac(device.mac) !== mac
    }))
  }

  /**
   * The configuration to save to start a plugin that is not running. A plugin
   * never configured has no Enabled switch in the admin UI, only "Save
   * configuration to enable this plugin", and it hears nothing to add until it
   * runs; saving its configuration as it is (no devices yet) enables it.
   */
  function startConfiguration(configuration) {
    return withDevices(configuration, configuredDevices(configuration))
  }

  function withDevices(configuration, devices) {
    var next = Object.assign({}, configuration || {}, { devices: devices })
    delete next.discovered
    return next
  }

  // -------------------------------------------------------------------------
  // Panel
  // -------------------------------------------------------------------------

  function createPanel(React) {
    var h = React.createElement

    function badge(color, text, key) {
      return h('span', { key: key, className: 'badge bg-' + color }, text)
    }

    function field(props) {
      var error = props.errors[props.name]
      return h('div', { className: props.width },
        h('label', { className: 'form-label', htmlFor: 'victron-ble-' + props.name }, props.label),
        h('input', {
          id: 'victron-ble-' + props.name,
          className: 'form-control form-control-sm' + (props.mono ? ' font-monospace' : '') + (error ? ' is-invalid' : ''),
          type: 'text',
          value: props.draft[props.name],
          placeholder: props.placeholder,
          maxLength: props.maxLength,
          autoComplete: 'off',
          spellCheck: false,
          onChange: function (event) { props.onChange(props.name, event.target.value) }
        }),
        error
          ? h('div', { className: 'invalid-feedback' }, error)
          : props.help ? h('div', { className: 'form-text' }, props.help) : null)
    }

    function Editor(props) {
      var draft = props.draft
      var row = props.row
      var errors = props.showErrors ? validate(draft, props.configuration) : {}
      var showSecondary = row.supportsSecondaryBattery || Boolean(draft.secondaryBattery)
      var onChange = function (name, value) {
        props.setDraft(Object.assign({}, draft, { [name]: value }))
      }
      var fieldProps = function (extra) {
        return Object.assign({ draft: draft, errors: errors, onChange: onChange }, extra)
      }

      return h('div', null,
        h('div', { className: 'mb-2' },
          h('strong', null, draft.isNew ? 'Add ' : 'Change '),
          h('strong', null, typeLabel(row)),
          h('span', { className: 'text-body-secondary ms-2 font-monospace small' }, row.mac)),
        h('div', { className: 'row g-3' },
          field(fieldProps({
            name: 'name', label: 'Display name', width: 'col-md-4', placeholder: 'e.g. Starter Battery',
            help: mayBeShortened(row.advertisedName) && draft.name === row.advertisedName
              ? 'The device may have shortened its advertised name to fit Bluetooth\'s 29 characters; check it is complete.'
              : null
          })),
          field(fieldProps({
            name: 'id', label: 'Device ID', width: 'col-md-2', placeholder: 'e.g. 2',
            help: 'Signal K instance, e.g. electrical.batteries.<ID>'
          })),
          field(fieldProps({
            name: 'advertisementKey', label: 'Advertisement key', width: 'col-md-6', mono: true, maxLength: 32,
            placeholder: '32 hexadecimal characters',
            help: 'VictronConnect: device settings, Product info, Instant readout details, Show encryption data'
          })),
          showSecondary ? field(fieldProps({
            name: 'secondaryBattery', label: 'Secondary battery ID', width: 'col-md-4', placeholder: 'optional',
            help: 'Publish the auxiliary (starter) voltage as electrical.batteries.<ID>'
          })) : null,
          h('div', { className: 'col-12' },
            h('div', { className: 'form-check' },
              h('input', {
                id: 'victron-ble-enabled',
                className: 'form-check-input',
                type: 'checkbox',
                checked: draft.enabled,
                onChange: function (event) { onChange('enabled', event.target.checked) }
              }),
              h('label', { className: 'form-check-label', htmlFor: 'victron-ble-enabled' }, 'Enabled')))),
        h('div', { className: 'mt-3 d-flex gap-2' },
          h('button', { type: 'button', className: 'btn btn-primary btn-sm', onClick: props.onSave },
            draft.isNew ? 'Add device' : 'Save'),
          draft.isNew ? null : h('button', {
            type: 'button', className: 'btn btn-outline-danger btn-sm', onClick: props.onRemove
          }, 'Remove'),
          h('button', { type: 'button', className: 'btn btn-outline-secondary btn-sm', onClick: props.onCancel }, 'Cancel')))
    }

    function DeviceRow(props) {
      var row = props.row
      var status = statusOf(row)
      return h('tr', {
        className: props.selected ? 'table-active' : undefined,
        style: { cursor: 'pointer', fontStyle: row.configured ? 'normal' : 'italic' },
        title: row.configured ? 'Click to change this device' : 'Click to add this device',
        onClick: props.onSelect
      },
      h('td', {
        title: row.advertisedName && row.advertisedName !== nameOf(row) ? 'Advertised as ' + row.advertisedName : undefined
      }, nameOf(row) || '-'),
      h('td', null, typeLabel(row)),
      h('td', null, h('code', null, row.mac)),
      h('td', null, row.rssi === null ? '-' : badge(rssiColor(row.rssi), row.rssi + ' dBm')),
      h('td', null, formatAge(row.lastSeen, props.now)),
      h('td', null, row.configured && row.deviceId ? row.deviceId : '-'),
      h('td', null, status ? badge(status.color, status.label) : h('span', { className: 'text-body-secondary' }, 'Not configured')))
    }

    function DeviceTable(props) {
      if (props.rows.length === 0) {
        return h('p', { className: 'text-body-secondary mb-0 p-2' }, props.empty)
      }
      return h('div', { className: 'table-responsive', style: { maxHeight: LIST_MAX_HEIGHT, overflowY: 'auto' } },
        h('table', { className: 'table table-hover table-striped table-sm mb-0' },
          h('thead', { className: 'sticky-top' }, h('tr', null,
            ['Name', 'Type', 'MAC Address', 'RSSI', 'Last Seen', 'Device ID', 'Status'].map(function (title) {
              return h('th', { key: title }, title)
            }))),
          h('tbody', null, props.rows.map(function (row) {
            return h(DeviceRow, {
              key: row.mac, row: row, now: props.now, selected: row.mac === props.selected,
              onSelect: function () { props.onSelect(row) }
            })
          }))))
    }

    function Tabs(props) {
      return h('ul', { className: 'nav nav-tabs mb-2' }, props.tabs.map(function (tab) {
        return h('li', { key: tab.key, className: 'nav-item' },
          h('button', {
            type: 'button',
            className: 'nav-link' + (tab.key === props.active ? ' active' : ''),
            onClick: function () { props.onChange(tab.key) }
          }, tab.title + ' (' + tab.rows.length + ')'))
      }))
    }

    function Panel(props) {
      var configuration = props.configuration || {}
      var state = React.useState(null)
      var serverRows = state[0]
      var setServerRows = state[1]
      var errorState = React.useState(null)
      var setLoadError = errorState[1]
      var selectedState = React.useState(null)
      var selected = selectedState[0]
      var setSelected = selectedState[1]
      var draftState = React.useState(null)
      var draft = draftState[0]
      var setDraft = draftState[1]
      var showErrorsState = React.useState(false)
      var setShowErrors = showErrorsState[1]
      var messageState = React.useState(null)
      var setMessage = messageState[1]
      var nowState = React.useState(Date.now())
      var setNow = nowState[1]
      var tabState = React.useState(null)
      var setTab = tabState[1]
      var runningState = React.useState(true)
      var setRunning = runningState[1]

      React.useEffect(function () {
        var stopped = false
        function load() {
          fetch(DEVICES_URL, { credentials: 'same-origin' })
            .then(function (response) {
              if (!response.ok) throw new Error('HTTP ' + response.status)
              return response.json()
            })
            .then(function (body) {
              if (stopped) return
              setServerRows(body.devices || [])
              setRunning(body.running !== false)
              setLoadError(null)
              setNow(Date.now())
            })
            .catch(function (error) {
              if (!stopped) setLoadError(error.message)
            })
        }
        load()
        var timer = setInterval(load, REFRESH_MS)
        return function () { stopped = true; clearInterval(timer) }
      }, [])

      var rows = mergeRows(serverRows || [], configuration)
      var tabs = tabsFor(rows)
      // Until a tab is chosen: Configured when something is, else the first
      // type tab with devices
      var activeKey = tabState[0] ||
        (tabs[0].rows.length > 0 || tabs.length === 1 ? CONFIGURED_TAB : tabs[1].key)
      var activeTab = tabs.find(function (tab) { return tab.key === activeKey }) || tabs[0]
      var selectedRow = rows.find(function (row) { return row.mac === selected })

      function select(row) {
        setMessage(null)
        setShowErrors(false)
        setSelected(row.mac)
        setDraft(draftFor(row, configuration))
      }
      function close() {
        setSelected(null)
        setDraft(null)
        setShowErrors(false)
      }
      function save() {
        if (Object.keys(validate(draft, configuration)).length > 0) {
          setShowErrors(true)
          return
        }
        props.save(applyDraft(configuration, draft))
        setMessage((draft.isNew ? 'Added ' : 'Saved ') + draft.name.trim())
        close()
      }
      function start() {
        props.save(startConfiguration(configuration))
        setRunning(true)
        setMessage('Saved. The plugin starts and lists the devices it hears within a few seconds.')
      }
      function remove() {
        if (!root.confirm || root.confirm('Remove ' + (draft.name || draft.mac) + ' from the configuration?')) {
          props.save(removeDevice(configuration, draft.mac))
          setMessage('Removed ' + (draft.name || draft.mac))
          close()
        }
      }

      var list
      if (serverRows === null && !errorState[0]) {
        list = h('p', { className: 'text-body-secondary mb-0' }, 'Loading devices...')
      } else {
        list = h('div', null,
          h(Tabs, { tabs: tabs, active: activeTab.key, onChange: setTab }),
          h(DeviceTable, {
            rows: activeTab.rows, now: nowState[0], selected: selected, onSelect: select,
            empty: activeTab.key === CONFIGURED_TAB
              ? 'No devices configured yet. Pick one from a type tab to add it.'
              : 'No devices of this type heard.'
          }))
      }

      return h('div', null,
        h('div', { className: 'card mb-3' },
          h('div', { className: 'card-header' },
            h('strong', null, 'Victron devices'),
            badge('primary', String(rows.length), 'count'),
            h('span', { className: 'text-body-secondary ms-2 small' }, 'Click a device to add it or change its settings.')),
          h('div', { className: 'card-body' },
            errorState[0] ? h('div', { className: 'alert alert-warning py-2' },
              'Could not load the devices heard (' + errorState[0] + '). Is the plugin enabled?') : null,
            !errorState[0] && !runningState[0] ? h('div', { className: 'alert alert-warning py-2' },
              h('p', { className: 'mb-2' },
                'The plugin is not running, so it is not listening for Victron devices. ' +
                'Start it to list the devices it hears, then click one to add it. ' +
                'If the plugin is switched off above, turn on Enabled instead.'),
              h('button', { type: 'button', className: 'btn btn-primary btn-sm', onClick: start },
                'Start listening')) : null,
            rows.length === 0 && serverRows !== null
              ? h('p', { className: 'text-body-secondary mb-0' },
                runningState[0]
                  ? 'No Victron devices heard yet. Make sure Bluetooth is scanning (Server, BLE Manager).'
                  : 'No devices to show until the plugin is running.')
              : list)),
        h('div', { className: 'card' },
          h('div', { className: 'card-header' }, h('strong', null, 'Device settings')),
          h('div', { className: 'card-body' },
            messageState[0] ? h('div', { className: 'alert alert-success py-2' }, messageState[0]) : null,
            draft && selectedRow
              ? h(Editor, {
                row: selectedRow, draft: draft, setDraft: setDraft, configuration: configuration,
                showErrors: showErrorsState[0], onSave: save, onRemove: remove, onCancel: close
              })
              : messageState[0] ? null : h('p', { className: 'text-body-secondary mb-0' },
                'Select a device above to add it or change its settings.'))))
    }

    // Building blocks, for rendering them on their own in the tests
    Panel.parts = { DeviceTable: DeviceTable, Editor: Editor, Tabs: Tabs }
    return Panel
  }

  // -------------------------------------------------------------------------
  // Module Federation container
  // -------------------------------------------------------------------------

  function newestVersion(versions) {
    return versions.slice().sort(function (a, b) {
      var left = a.split('.').map(Number)
      var right = b.split('.').map(Number)
      for (var i = 0; i < 3; i += 1) {
        if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) - (right[i] || 0)
      }
      return 0
    }).pop()
  }

  var sharedReact = null
  var panel = null

  var container = {
    init: function (shareScope) {
      var reactScope = shareScope && shareScope.react
      var versions = reactScope ? Object.keys(reactScope) : []
      if (versions.length === 0) {
        return Promise.reject(new Error(PLUGIN_ID + ': the admin UI shared no React'))
      }
      return Promise.resolve(reactScope[newestVersion(versions)].get()).then(function (factory) {
        sharedReact = factory()
      })
    },
    get: function (module) {
      if (module !== PANEL_MODULE) {
        return Promise.reject(new Error(PLUGIN_ID + ' exposes no ' + module))
      }
      if (!sharedReact) {
        return Promise.reject(new Error(PLUGIN_ID + ': init() was not called'))
      }
      panel = panel || createPanel(sharedReact)
      return Promise.resolve(function () { return { default: panel } })
    }
  }

  var api = {
    container: container,
    createPanel: createPanel,
    applyDraft: applyDraft,
    draftFor: draftFor,
    formatAge: formatAge,
    mergeRows: mergeRows,
    mayBeShortened: mayBeShortened,
    nameOf: nameOf,
    removeDevice: removeDevice,
    startConfiguration: startConfiguration,
    rssiColor: rssiColor,
    statusOf: statusOf,
    tabsFor: tabsFor,
    typeTabOf: typeTabOf,
    typeLabel: typeLabel,
    validate: validate
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = api
  } else {
    root.signalk_victron_ble_consumer = container
  }
})(typeof window !== 'undefined' ? window : globalThis)
