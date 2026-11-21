# Signal K Victron BLE Consumer

This standalone consumer receives generic advertisement events from the
gateway provider, selects configured Victron devices, and decrypts Instant
Readout data exclusively on the Signal K server.

It requires Signal K Server 2.31 or newer, which provides the official BLE
Provider API.

This consumer is designed for the new Signal K BLE Provider API and the
SensESP BLE Gateway transport. It receives
Victron advertisements through `app.bleApi`, including advertisements supplied
by remote ESP32 gateways, instead of opening a local BlueZ adapter itself. This
allows several consumers to share one BLE stream and supports coverage across
multiple vessel compartments.

## Installation

Install `signalk-victron-ble-consumer` from the Signal K AppStore, then enable
and configure it under **Server > Plugin Config**. The current stable release
is `0.2.2` and includes SmartSolar MPPT and Orion Smart DC-DC support. The
additional specification-based Victron record decoders are explicitly marked
as untested in the supported-device table below.

To install the released source directly on a Signal K server, use the
`consumer-plugin` directory from the upstream repository tag. The package
manifest lives there, not at the repository root.

```sh
git clone -b v0.2.2 https://github.com/haipule/signalk-ble-gateway.git
cd ~/.signalk
npm install /path/to/signalk-ble-gateway/consumer-plugin
```

Restart Signal K after installation, enable the plugin, and configure each
device with its 32-character Victron advertisement key. The plugin requires
the official Signal K BLE Provider API and a provider that supplies the
advertisements.

## Development installation

```sh
cd consumer-plugin
npm link
cd ~/.signalk
npm link signalk-victron-ble-consumer
```

Restart Signal K, enable the plugin, and configure each device with a
display name, Signal K path, BLE MAC address, and 32-character advertisement
key. The
gateway provider must be enabled at the same time.

The diagnostic web application is available at:

```text
http://SIGNALK-SERVER:3000/signalk-victron-ble-consumer/
```

Keys are never returned by the status API or web application.

In the paths below, `<id>` stands for the device's configured **Signal K
path**, which goes below the group: `1` gives `electrical.batteries.1`.

Lynx Smart BMS voltage, current, state of charge, time remaining, and
temperature are published below `electrical.batteries.<id>`. The web
application additionally shows consumed capacity, BMS error, I/O status, and
warning/alarm bit fields.

Orion XS is published as a charger:

```text
electrical.chargers.<id>.voltage
electrical.chargers.<id>.current
electrical.chargers.<id>.inputVoltage
electrical.chargers.<id>.inputCurrent
```

SmartSolar MPPT values are published as solar, the Signal K group that defines
leaves for panel power and daily yield:

```text
electrical.solar.<id>.voltage
electrical.solar.<id>.current
electrical.solar.<id>.panelPower
electrical.solar.<id>.yieldToday
electrical.solar.<id>.loadCurrent
```

Yield is published in joules, the Signal K unit for `yieldToday`. The
advertisement carries 0.01 kWh units, which the consumer converts.

Orion Smart DC-DC converters advertise record `0x04`, which carries only
voltages:

```text
electrical.chargers.<id>.voltage
electrical.chargers.<id>.inputVoltage
```

For Issue #1 testing, please compare these values with `victron-ble read` and
report the plugin status, Signal K paths, and any errors. Do not post the
advertisement key. If raw advertisements are needed, mask the MAC address and
share only the payload and RSSI.

Operating state and charger error are published as text alongside the
measurements:

```text
electrical.solar.<id>.chargingMode
electrical.solar.<id>.chargerState
electrical.solar.<id>.chargerError
electrical.chargers.<id>.chargingMode
electrical.chargers.<id>.chargerState
electrical.chargers.<id>.chargerError
```

`chargingMode` is a Signal K schema leaf with an enumerated vocabulary:
`bulk`, `acceptance`, `overcharge`, `float`, `equalize`, `unknown` or `other`.
VE.Direct states do not map one to one, so Victron's `absorption` is published
as `acceptance`, and a state with no Signal K equivalent, such as
`external_control`, is published as `other`.

`chargerState` and `chargerError` are explicit extensions, as the schema
defines no leaf for either. They carry the exact VE.Direct names, for example
`bulk`, `absorption`, `float`, `external_control` and `no_error`, so the
precise device state is preserved. A code without a settled meaning is
published as `unknown_<n>` rather than guessed.

## Device identity and reception

Each Victron device is also published as a Signal K sensor, keyed by its MAC
address written with dashes, so the path is stable across renames:

```text
sensors.<MAC>.name             configured display name
sensors.<MAC>.sensorType       model from the product ID
sensors.<MAC>.vendor           Victron Energy
sensors.<MAC>.advertisedName   name advertised over BLE, when there is one
sensors.<MAC>.RSSI             signal strength, dBm
sensors.<MAC>.lastSeen         time of the last decoded reading
sensors.<MAC>.dataType         path of the readings less its last segment, e.g. electrical.batteries
sensors.<MAC>.instance         last segment of that path, e.g. 2
```

For example, a Smart Battery Sense configured with the path `2`:

```text
sensors.D5-9E-F7-D6-F6-92.sensorType   Smart Battery Sense (Rev2)
sensors.D5-9E-F7-D6-F6-92.dataType     electrical.batteries
sensors.D5-9E-F7-D6-F6-92.instance     2
electrical.batteries.2.voltage         its readings
```

`<dataType>.<instance>` is where the readings are published, which links a
sensor to the battery, charger or inverter it measures. A record type
without a Signal K group (Smart Battery Protect, Multi RS, VE.Bus, DC energy
meter) has no `dataType` or `instance`. The measured item itself gets only
its `name`: a battery watched by a Smart Battery Sense or SmartShunt is not a
Victron product, so no manufacturer is claimed for it. The model is the hex
product ID when it is not known. Identity is published when it changes,
`RSSI` and `lastSeen` with every reading.

The path can have more than one segment. Two lithium batteries that make up
bank 1 can be `1.lithium.1` and `1.lithium.2`, publishing below
`electrical.batteries.1.lithium.1` and `electrical.batteries.1.lithium.2`.
For the first, `dataType` is `electrical.batteries.1.lithium` and
`instance` is `1`, so `<dataType>.<instance>` is still where the readings
are. A leading dot, as in `.1.lithium.1`, is ignored.

The source of a device's data is its display name, so Signal K shows it as
`signalk-victron-ble-consumer.<name>`, e.g.
`signalk-victron-ble-consumer.12v Bat 1`. Names must therefore differ, and
renaming a device changes its source.

## Configuring devices

The plugin has its own configuration page in the Signal K admin UI (Server,
Plugin Config, Victron BLE Consumer), in place of a generated form. It has
two areas. The plugin only listens for devices while it is running. Before
it has ever been configured the admin UI shows no Enabled switch, so the
page offers **Start listening**, which saves the configuration (no devices
yet) and so enables the plugin; the devices it hears then appear.

- **Victron devices** lists every Victron device heard in the last 15
  minutes, plus every configured device, in tabs: **Configured** first, then
  by type (**Batteries**; **Converters** for solar, DC-DC and AC chargers,
  inverters and inverter/chargers; **Smart BatteryProtect**; **DC Energy
  Meters**; **Other**).
  Each row shows the name, type, MAC address, RSSI, when it was last heard,
  its Signal K path and its status (Online, Waiting,
  Wrong key, Not heard, Disabled). The list refreshes every 5 seconds and
  is ordered by type, then name, so rows stay put as signal strength changes.
- **Device settings**: click a device to add it, or to change it if it is
  already configured. The MAC address and a display name are filled in from
  what was heard; enter the advertisement key from VictronConnect (device
  settings, Product info, Instant readout details, Show encryption data) and
  the **Signal K path** below the device's group, shown in front of the
  field: `2` for `electrical.batteries.2`. Two devices cannot share a path
  in the same group. A type Signal K has no group for (Smart
  BatteryProtect, Multi RS, VE.Bus, DC energy meter) needs none. A BMV or
  SmartShunt also offers the secondary battery path. **Add device** or **Save** stores it, **Remove** deletes it.

  The Name column shows a configured device's display name, otherwise the
  name it advertises. One advertisement carries at most 29 characters of
  name, so devices with longer names send them shortened, e.g.
  `24v Lithium House Bank NG (40`; correct the display name to the full one.
  The advertised name stays available as `sensors.<MAC>.advertisedName`.

Devices are identified without their key: the product ID and record type
travel in the unencrypted Instant Readout header, and the advertised name in
clear. Up to 256 devices are remembered, the least recently heard dropped
first; the list survives a plugin restart but not a server restart.

The page is `public/remoteEntry.js`, loaded by the admin UI because
`package.json` carries the keyword `signalk-plugin-configurator`. It is
written without a bundler and uses the admin UI's own React, so the plugin
has no build step and no runtime dependencies. It reads
`/plugins/signalk-victron-ble-consumer/devices`, which needs an admin login
and never returns advertisement keys.

## Records decoded from the specification but not yet tested

The following records are decoded from the published Victron "Extra
manufacturer data" specification, with tests built from the documented
layouts. No hardware was available, so their values are unverified.

```text
0x02  battery monitor   SmartShunt, BMV   -> electrical.batteries.<id>
0x03  inverter          Phoenix           -> electrical.inverters.<id>
0x05  SmartLithium                        -> electrical.batteries.<id>
0x06  Inverter RS                         -> electrical.inverters.<id>
0x09  Smart Battery Protect               -> diagnostic only
0x0B  Multi RS                            -> diagnostic only
0x0C  VE.Bus                              -> diagnostic only
0x0D  DC energy meter                     -> diagnostic only
```

The battery monitor and DC energy meter records carry a 16-bit auxiliary field
whose meaning depends on a 2-bit selector stored after it: starter voltage,
mid-point voltage, or temperature. Only the selected reading is returned; the
others are null, because the same bits mean different things per device
configuration. Mid-point voltage has no Signal K leaf and remains available in
the status API only. For a BMV or SmartShunt whose auxiliary input measures a
separate starter battery, set the optional **Secondary battery path** on
that device. An auxiliary voltage is then published as
`electrical.batteries.<secondary path>.voltage`; temperature and mid-point modes
never use this mapping. Leave the option empty to retain the default behavior.
The device settings offer the option only for a device identified as a BMV
or SmartShunt from its advertised model ID that sends battery monitor records
(a shunt set up as a DC energy meter does not), or one that already has a
value.
The DC energy meter has no mid-point reading, so that selector is rejected for
it rather than producing a value the record does not carry.

SmartLithium cell voltages are reported as a bound and a voltage, because the
specification defines the two end values as thresholds rather than
measurements:

```text
{ bound: 'below', voltage_v: 2.61 }   cell is under 2.61 V, no lower bound given
{ bound: 'exact', voltage_v: 3.25 }   a measurement
{ bound: 'above', voltage_v: 3.85 }   cell is over 3.85 V, no upper bound given
null                                  not available
```

An unavailable cell keeps its position in the list, so cell numbering stays
meaningful when one reading is missing.

Besides pack `voltage` and `temperature`, a SmartLithium battery publishes
each available cell as `electrical.batteries.<id>.cell<N>.voltage` (V; a
bound is published at its threshold) and the balancer as
`electrical.batteries.<id>.balancerStatus` (`balanced`, `balancing`,
`imbalance` or `unknown`). Signal K defines neither leaf, so these follow the
paths bt-sensors-plugin-sk uses for the same battery, with units and
descriptions sent as metadata. The record carries no current or state of
charge; those come from the battery monitor or BMS. The BMS and error flags
stay in the status API.

Records `0x07` and `0x08` are not implemented. The specification marks both
layouts as still to be determined and subject to change, so decoding them
would be guesswork.

If you have any of these devices, please compare the plugin values with
VictronConnect and report the result. Do not post advertisement keys, and mask
MAC addresses in any capture you share.
