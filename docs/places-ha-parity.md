# Places - Home Assistant connectivity parity

Standing rule: Places connects to at least everything Home Assistant connects to.
This file is the ledger of where that stands and the backlog for the batches that
close the gap. One row per Home Assistant integration that brings devices into a
house; cloud services, helpers and pure software integrations are out of scope.

Status values:

- **supported** - Places has its own connection and driver for it
  (`dashboard/apps/places/src/lib/device-connections.ts`, `drivers/`).
- **partial** - Places has a way in, but not for every device class or protocol
  the Home Assistant integration covers; the note says what is missing.
- **via HA bridge** - no direct driver; the devices arrive through the Home
  Assistant connection, which today maps only the `switch`, `light`, `lock`,
  `climate`, `sensor` and `binary_sensor` domains (`drivers/home-assistant.ts`).
  Anything in another domain (cover, fan, vacuum, media_player, humidifier,
  water_heater, valve, lawn_mower, camera) does not come through the bridge either.
- **missing** - neither a driver nor a bridge path for the device classes that
  matter for it.

Priority is an estimate of how many houses have it, from the size of each
integration's install base on Home Assistant's public analytics
(analytics.home-assistant.io). Re-check the order there before a batch starts:
**P1** most common, **P2** common, **P3** niche.

Domains are Home Assistant's integration ids. "(custom)" marks a HACS
integration that is not part of Home Assistant core but is how its users connect
that make.

## Radio protocols and hubs

| HA integration | Places status | Notes | Priority |
| --- | --- | --- | --- |
| `zha` (Zigbee) | via HA bridge | No Zigbee coordinator support of our own. Zigbee2MQTT devices arrive through MQTT discovery (switch, light, lock only). | P1 |
| `mqtt` | partial | `mqtt-discovery` reads Home Assistant discovery topics for switch, light and lock; no sensor, cover, climate, fan. | P1 |
| `zwave_js` (Z-Wave) | via HA bridge | Needs a Z-Wave JS server client. | P1 |
| `matter` | missing | No Matter controller. Covers IKEA, Aqara, Eve, Nanoleaf, SwitchBot hubs and most new devices. | P1 |
| `thread` / `otbr` | missing | Only meaningful together with Matter. | P2 |
| `homekit_controller` | missing | Local HomeKit Accessory Protocol pairing (Eve, Aqara, Nanoleaf, Meross...). | P2 |
| `esphome` | partial | Only through MQTT discovery when the node is configured for MQTT; the native API is not spoken. | P1 |
| `tasmota` | partial | Only when the device publishes Home Assistant MQTT discovery; Tasmota's own discovery format is not read. | P2 |
| `deconz` | via HA bridge | Phoscon/ConBee REST API. | P2 |
| `knx` | missing | KNX/IP tunnelling. | P3 |
| `modbus` | missing | | P3 |
| `homematicip_cloud` / `homematic` | via HA bridge | | P2 |
| `bthome` / `xiaomi_ble` / `govee_ble` / `inkbird` | missing | No Bluetooth proxy or BLE advertisement listener (besides Hue BLE). | P2 |

## Lighting, plugs and switches

| HA integration | Places status | Notes | Priority |
| --- | --- | --- | --- |
| `hue` | supported | `hue-bridge` (lights, plugs); `hue-ble` listed. Sensors and motion from the bridge not read. | P1 |
| `tplink` (Tapo, Kasa) | supported | `tapo-local`, `kasa-local`: plugs, strips, switches, bulbs. Tapo hubs and sensors not covered. | P1 |
| `tuya` | supported | `tuya-app` (Smart Life / Tuya Smart QR), `tuya-cloud`. Covers, fans, vacuums missing as kinds. | P1 |
| `shelly` | supported | `shelly-local`: relays, plugs, dimmers, bulbs. Covers (roller mode), energy meters, H&T sensors missing. | P1 |
| `switchbot_cloud` / `switchbot` | partial | Cloud API supported; local Bluetooth (`switchbot`) missing. Curtain and Blind Tilt need a cover kind. | P1 |
| `tradfri` / DIRIGERA | supported | `dirigera-hub`: lights, outlets, sensors. The old TRADFRI gateway is not. | P2 |
| `dynalite` | supported | `philips-dynalite`. | P3 |
| `lifx` | via HA bridge | Local LAN protocol, no account. | P2 |
| `nanoleaf` | via HA bridge | Local API with a pairing button. | P2 |
| `yeelight` | via HA bridge | Local LAN control once enabled in the app. | P2 |
| `wiz` | via HA bridge | Local UDP. | P2 |
| `govee_light_local` / Govee cloud | via HA bridge | | P2 |
| `wemo` | via HA bridge | | P3 |
| `lutron_caseta` | via HA bridge | | P2 |
| `sonoff` (custom, eWeLink) | via HA bridge | eWeLink cloud + LAN. Sonoff on Tasmota/ESPHome goes through MQTT. | P1 |
| `meross_lan` (custom) / `meross_cloud` | missing | | P2 |
| `xiaomi_miio` / Mi Home | via HA bridge | Token-based local protocol; plugs, purifiers, fans, vacuums. | P1 |
| Aqara (`xiaomi_aqara`, Matter, HomeKit) | via HA bridge | Aqara hubs reach HA through Matter or HomeKit. | P1 |
| `bond` | missing | Fans and shades (cover/fan domains). | P3 |

## Climate, air and appliances

| HA integration | Places status | Notes | Priority |
| --- | --- | --- | --- |
| `gree` | supported | `gree-local`: air conditioners on the Gree+ protocol. | P2 |
| `midea_ac_lan` (custom) | partial | `midea-lan`: dehumidifiers (0xA1) through an MSmartHome account. Air conditioners (0xAC), fans, water heaters and the other clouds (NetHome Plus, Midea Air, Toshiba Iolife...) missing. | P1 |
| `philips_air` (custom) / Philips Air+ | supported | `philips-coap`, `philips-cloud`: purifiers, humidifiers, some HomeID/NutriU appliances. | P2 |
| `daikin` / `onecta` (custom) | via HA bridge | Local (BRP) and cloud. | P1 |
| `lg_thinq` | via HA bridge (climate only) | Washers, fridges, dishwashers have no Places kind. | P1 |
| `smartthings` | via HA bridge | Samsung appliances, TVs, sensors. | P1 |
| `home_connect` (Bosch, Siemens, Neff) | missing | Appliance domains not mapped. | P2 |
| `miele` | missing | | P2 |
| `sensibo` | via HA bridge | | P3 |
| `tado` | via HA bridge | | P2 |
| `netatmo` | via HA bridge | Thermostats, weather, cameras (cameras missing). | P1 |
| `ecobee` / `nest` / `honeywell` / `evohome` | via HA bridge | | P1 |
| `mill` | via HA bridge | | P3 |
| `airthings` / `awair` | via HA bridge | Sensors only. | P3 |

## Robots, covers and outdoor

| HA integration | Places status | Notes | Priority |
| --- | --- | --- | --- |
| `roborock` | missing | Vacuum domain not mapped anywhere. | P1 |
| `ecovacs` | missing | | P1 |
| `dreame` (custom, dreame-vacuum) | missing | | P2 |
| `irobot` (Roomba) | missing | | P1 |
| `husqvarna_automower` | missing | Lawn mower domain. | P2 |
| `overkiz` (Somfy TaHoma) / `somfy_mylink` | missing | Cover domain not mapped. | P2 |
| `hunterdouglas_powerview` | missing | Covers. | P3 |
| `velux` | missing | Covers. | P3 |
| `rachio` | missing | Valves/irrigation. | P3 |

## Locks, doors and security

| HA integration | Places status | Notes | Priority |
| --- | --- | --- | --- |
| `nuki` | supported | `nuki-web`, `nuki-local` (MQTT). | P2 |
| `yale` / `august` | via HA bridge | | P2 |
| `schlage` | via HA bridge | | P3 |
| `ring` | missing | Doorbells and cameras. | P1 |
| `petkit` (custom) | supported | `petkit-cloud`: litter boxes. Feeders and fountains missing. | P3 |

## Cameras

| HA integration | Places status | Notes | Priority |
| --- | --- | --- | --- |
| `onvif` / `generic` | supported | Places cameras (`lib/cameras.ts`): RTSP/ONVIF. | P1 |
| `reolink` | supported | Camera catalogue. | P1 |
| `hikvision` / Dahua / `amcrest` | supported | Camera catalogue. | P2 |
| `tapo_control` (custom) | supported | Tapo and VIGI in the camera catalogue. | P1 |
| `unifiprotect` | missing | | P1 |
| `ezviz` / `blink` | missing | Cloud-only cameras. | P2 |
| `frigate` (custom) | missing | | P2 |

## Media and TV

| HA integration | Places status | Notes | Priority |
| --- | --- | --- | --- |
| `philips_js` | partial | `philips-tv`: power only (switch); no media_player. | P3 |
| `cast` / `sonos` / `apple_tv` / `samsungtv` / `webostv` / `androidtv_remote` / `roku` | missing | No media_player kind in Places. | P1 |

## Energy

| HA integration | Places status | Notes | Priority |
| --- | --- | --- | --- |
| `enphase_envoy` / `fronius` / `solaredge` | missing | No energy kind. | P2 |
| `tesla_wall_connector` / `easee` / `wallbox` | missing | EV chargers. | P3 |
| `fritz` / `fritzbox` | via HA bridge | Smart plugs and thermostats through FRITZ!Box. | P2 |

## What unblocks the most rows

1. Map more Home Assistant domains in the bridge (`cover`, `fan`, `vacuum`,
   `humidifier`, `media_player`, `valve`): every "via HA bridge" or "missing" row
   in those domains moves to at least partial without a new driver.
2. MQTT discovery for sensors, covers and climate: Zigbee2MQTT, Tasmota and
   ESPHome houses get their whole inventory.
3. A Matter controller: the one protocol most new devices of every make ship with.
4. Direct drivers for the P1 makes still missing: Roborock, Xiaomi Mi Home,
   eWeLink, Daikin, LG ThinQ, SmartThings, UniFi Protect, Ring.
