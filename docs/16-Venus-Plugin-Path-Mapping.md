# Signal K paths: signalk-venus-plugin and the Victron BLE consumer

The same Victron device can reach Signal K twice: through a GX device, read
by [signalk-venus-plugin](https://github.com/sbender9/signalk-venus-plugin),
and over Bluetooth, read by `signalk-victron-ble-consumer`. Where the venus
plugin already publishes a kind of device, the BLE consumer uses the same
group, leaves and values. The two sources then meet on one path and can be
ranked in Signal K's source priorities, with the BLE reading taking over
when the GX goes quiet (or the reverse).

This table lists each device type's base path in both plugins, then the
leaves below it. Checked against signalk-venus-plugin 2.4.1.

## Base paths

`<instance>` is the GX device's VRM instance for the device, for example
`279`. `<path>` is the **Signal K path** configured for the device in the BLE
consumer. Set `<path>` to the device's VRM instance to make the two paths
identical.

| Device type | BLE record | Venus service | venus plugin base path | BLE consumer base path |
|---|---|---|---|---|
| BMV, SmartShunt, Smart Battery Sense | 0x02 | `battery` | `electrical.batteries.<instance>` | `electrical.batteries.<path>` |
| Lynx Smart BMS | 0x0A | `battery` | `electrical.batteries.<instance>` | `electrical.batteries.<path>` |
| SmartLithium battery | 0x05 | none (seen through its BMS) | – | `electrical.batteries.<path>` |
| SmartSolar / BlueSolar MPPT | 0x01 | `solarcharger` | `electrical.solar.<instance>` | `electrical.solar.<path>` |
| Phoenix Smart / Blue Smart IP charger | 0x08 | `charger` | `electrical.chargers.<instance>` | `electrical.chargers.<path>` |
| Orion Smart DC-DC | 0x04 | `dcdc` | `electrical.dcdc.<instance>` | `electrical.dcdc.<path>` |
| Orion XS | 0x0F | `dcdc` | `electrical.dcdc.<instance>` | `electrical.dcdc.<path>` |
| Orion as alternator (**Role: Alternator**) | 0x04, 0x0F | `alternator` | `electrical.alternator.<instance>` | `electrical.alternator.<path>` |
| MultiPlus / Quattro (VE.Bus) | 0x0C | `vebus` | `electrical.chargers.<instance>` and `electrical.inverters.<instance>` | `electrical.chargers.<path>` and `electrical.inverters.<path>` |
| SmartShunt / BMV as DC energy meter | 0x0D | by monitor mode, see below | `electrical.<service>.<instance>` | `electrical.<service>.<path>` |
| Smart BatteryProtect | 0x09 | none | – | `electrical.switches.<path>` |
| Phoenix inverter | 0x03 | `inverter` | `electrical.inverters.<instance>` | `electrical.inverters.<path>` |
| Inverter RS | 0x06 | `inverter` | `electrical.inverters.<instance>` | `electrical.inverters.<path>` |
| Multi RS | 0x0B | `multi` | `electrical.multi.<instance>` | not published |

Every BLE device also publishes `<base>.name` (the configured display name),
as the venus plugin publishes the GX's custom name, and identifies itself
under `sensors.<MAC>` (see the consumer README).

### DC energy meter groups

A SmartShunt or BMV in DC energy meter mode becomes a different Venus service
depending on its monitor mode (gui-v2 `Enums::dcMeter_type`), and the venus
plugin publishes each service as `electrical.<service>`:

| Monitor mode | Venus service | Base path (both plugins) |
|---|---|---|
| −9 solar charger | `solarcharger` | `electrical.solar.*` |
| −8 wind charger, −7 shaft generator, −4 water generator, −3 DC/DC charger, −2 AC charger, −1 generic source | `dcsource` | `electrical.dcsource.*` |
| −6 alternator | `alternator` | `electrical.alternator.*` |
| −5 fuel cell | `fuelcell` | `electrical.fuelcell.*` |
| 1 generic load, 3 fridge, 4 water pump, 5 bilge pump, 7 inverter, 8 water heater | `dcload` | `electrical.dcload.*` |
| 2 electric drive | `motordrive` | `electrical.motordrive.*` |
| 6 DC system | `dcsystem` | `electrical.dcsystem.*` |

## Leaves

Leaves are relative to the base path. "Same" means both plugins publish the
leaf with the same unit and meaning. A leaf published by only one plugin is
marked, with the reason.

### Battery monitor (BMV, SmartShunt, Smart Battery Sense) and Lynx Smart BMS

| Leaf | Unit | venus plugin | BLE consumer | Notes |
|---|---|---|---|---|
| `voltage` | V | yes | yes | same |
| `current` | A | yes | yes | same; a Smart Battery Sense has no current sensor and sends none |
| `power` | W | yes | – | not in the advertisement |
| `temperature` | K | yes | yes | same; BMV/SmartShunt only when the aux input measures temperature |
| `capacity.stateOfCharge` | ratio | yes | yes | same |
| `capacity.timeRemaining` | s | yes | yes | same |
| `capacity.consumedCharge` | C | yes | yes | same; negative while charge has been taken out, as on Venus |
| `capacity.dischargeSinceFull` | C | yes (last discharge) | – | not in the advertisement |
| `capacity.dischargedEnergy` | C | yes | – | not in the advertisement |
| `lifetimeDischarge` | C | yes | – | not in the advertisement |
| `midVoltage`, `midVoltageDeviation` | V | yes | – | in the BMV/SmartShunt advertisement (aux mid-point mode), not yet published |
| `<instance>-second.voltage` | V | yes (starter battery, `/Dc/1/Voltage`) | – | the BLE consumer publishes the aux voltage to its own **Secondary battery path**, `electrical.batteries.<secondary>.voltage`, instead |

### SmartLithium battery

No venus plugin equivalent. Leaves follow the Signal K battery schema and,
for cells and balancer, bt-sensors-plugin-sk.

| Leaf | Unit | BLE consumer | Notes |
|---|---|---|---|
| `voltage` | V | yes | |
| `temperature` | K | yes | |
| `cell<N>.voltage` | V | yes | each cell the pack has; as bt-sensors-plugin-sk |
| `balancerStatus` | text | yes | `balanced`, `balancing`, `imbalance`, `unknown`; as bt-sensors-plugin-sk |

### Solar charger

| Leaf | Unit | venus plugin | BLE consumer | Notes |
|---|---|---|---|---|
| `voltage` | V | yes | yes | same (battery side) |
| `current` | A | yes | yes | same (battery side) |
| `panelPower` | W | yes | yes | same |
| `yieldToday` | J | yes | yes | same |
| `controllerMode` | text | yes | yes | same names, e.g. `not charging`, `bulk`, `absorption`, `float`, `external control` |
| `controllerModeNumber` | number | yes | yes | same |
| `loadCurrent` | A | – | yes | Signal K schema leaf; MPPTs with a load output only |
| `panelVoltage`, `panelCurrent` | V, A | yes | – | not in the advertisement |
| `yieldYesterday`, `systemYield` | J | yes | – | not in the advertisement |
| `loadState` | | yes | – | not in the advertisement |
| error | | `notifications.electrical.solar.<instance>.error` | – | BLE: status page only |

### AC charger (Phoenix Smart, Blue Smart IP)

| Leaf | Unit | venus plugin | BLE consumer | Notes |
|---|---|---|---|---|
| `voltage`, `current` | V, A | yes | yes | same (output 1) |
| `<base>-second.voltage`, `.current` | V, A | yes | yes | same (output 2) |
| `<base>-third.voltage`, `.current` | V, A | yes | yes | same (output 3) |
| `temperature` | K | yes | yes | same |
| `acin.1.current` | A | yes | yes | same |
| `chargingMode` | text | yes | yes | same names, e.g. `bulk`, `absorption`, `float`, `storage`, `power supply` |
| `chargingModeNumber` | number | yes | yes | same |
| error | | `notifications.electrical.chargers.<instance>.error` | – | BLE: status page only |

### DC-DC charger and Orion XS (or alternator, by role)

| Leaf | Unit | venus plugin | BLE consumer | Notes |
|---|---|---|---|---|
| `voltage` | V | yes | yes | same (output) |
| `current` | A | yes | Orion XS only | same (output) |
| `input.voltage` | V | yes | yes | same |
| `input.current` | A | yes | Orion XS only | same |
| `input.power` | W | yes | – | not in the advertisement |
| `chargingMode` | text | yes | yes | same names. DC-DC: the plugin's own, e.g. `off`, `absorbtion`, `Ext Control` (7); unnamed states as their number. Alternator: `off`, `bulk`, `absorption`, `float`, `external control` |
| `chargingModeNumber` | number | yes | yes | same |
| error | | `notifications.electrical.<group>.<instance>.error` | – | BLE: status page only |

### MultiPlus / Quattro (VE.Bus)

| Leaf | Unit | venus plugin | BLE consumer | Notes |
|---|---|---|---|---|
| `chargers.*.voltage` | V | yes | yes | same (battery) |
| `chargers.*.current` | A | yes | yes | same (battery, + charging) |
| `chargers.*.temperature` | K | yes | yes | same (battery) |
| `chargers.*.capacity.stateOfCharge` | ratio | yes | yes | same (the MultiPlus's own figure) |
| `chargers.*.chargingMode` | text | yes | yes | same names, e.g. `inverting`, `passthru`, `float`, `external control` |
| `chargers.*.chargingModeNumber` | number | yes | yes | same |
| `inverters.*.inverterMode` | text | yes | yes | same names as chargingMode |
| `inverters.*.inverterModeNumber` | number | yes | yes | same |
| `inverters.*.acin.power` | W | yes | yes | same (active input) |
| `inverters.*.acout.power` | W | yes | yes | same |
| `inverters.*.acin.voltage`, `.current`, `acout.voltage`, `.current`, frequencies | | yes | – | not in the advertisement |
| `inverters.*.acin.acSource` | text | yes | – | the advertisement gives the active input's number (AC-in 1/2), not its source type |
| mode, current limits | | yes | – | not in the advertisement |

### DC energy meter

| Leaf | Unit | venus plugin | BLE consumer | Notes |
|---|---|---|---|---|
| `voltage` | V | yes | yes | same |
| `current` | A | yes | yes | same |
| `power` | W | yes | yes | same; BLE computes voltage × current, as the GX does |
| `temperature` | K | yes | yes | same; when the aux input measures temperature |
| `<base>-second.voltage` | V | yes | yes | same; when the aux input measures a starter voltage |

### Smart BatteryProtect

No venus plugin equivalent. Published as a load switch, where the venus
plugin publishes a GX device's switchable outputs.

| Leaf | Unit | BLE consumer | Notes |
|---|---|---|---|
| `state` | bool | yes | `true` when the output is on, as the venus plugin's switch `state` |
| `voltage` | V | yes | output voltage |
| `input.voltage` | V | yes | input (battery side) voltage |
| `deviceState` | text | yes | e.g. `active`, `off`; this plugin's own leaf |
| `offReason` | text | yes | e.g. `remote_input`, `none`; this plugin's own leaf |

### Phoenix inverter and Inverter RS: not yet aligned

These have not been moved to the venus plugin's leaves; no such device was
available to check them against.

| venus plugin | BLE consumer today | Device |
|---|---|---|
| `voltage` | `dc.voltage` | both |
| `current` | `dc.current` | Inverter RS |
| `acout.voltage` | `ac.lineNeutralVoltage` | Phoenix |
| `acout.current` | `ac.current` | Phoenix |
| `acout.power` | `ac.realPower` | Inverter RS |
| – | `ac.apparentPower` (VA) | Phoenix; the venus plugin has no apparent power leaf |
| `inverterMode`, `inverterModeNumber` | – | both; in the advertisement, not yet published |
