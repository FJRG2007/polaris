"""Entities for the rest of the console screen: uplink, bays, scrub, Time
Machine, the native fan profile, backup task health and SMB sign-ins.

Each entity reads the retained MQTT values the agent publishes (see the
topic layout generated into `_generated.py`) or the backup task list the
coordinator already fetches. The rules that decide "problem" states live in
`logic.py`.
"""

from __future__ import annotations

import logging

from homeassistant.components import mqtt
from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.components.button import ButtonEntity
from homeassistant.components.event import EventEntity
from homeassistant.components.select import SelectEntity
from homeassistant.components.sensor import SensorDeviceClass, SensorStateClass
from homeassistant.const import PERCENTAGE, EntityCategory, UnitOfDataRate, UnitOfTemperature, UnitOfTime
from homeassistant.core import callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from homeassistant.util import dt as dt_util

from . import logic
from .const import DOMAIN, get_backup_device_info, get_device_info
from ._generated import CONTROL_TOPICS, FAN_PROFILES

_LOGGER = logging.getLogger(__name__)

SIGN_IN_EVENT = "smb_session_started"

# (mqtt_key, name, unit, device_class, state_class, icon, diagnostic)
CONSOLE_SENSORS = [
    ("unas_net_ip", "IP Address", None, None, None, "mdi:ip-network", True),
    ("unas_net_interface", "Network Interface", None, None, None, "mdi:ethernet", True),
    ("unas_net_speed", "Link Speed", UnitOfDataRate.MEGABITS_PER_SECOND, SensorDeviceClass.DATA_RATE, None, "mdi:speedometer", True),
    ("unas_net_rx_rate", "Network Download", UnitOfDataRate.MEBIBYTES_PER_SECOND, SensorDeviceClass.DATA_RATE, SensorStateClass.MEASUREMENT, "mdi:download-network", False),
    ("unas_net_tx_rate", "Network Upload", UnitOfDataRate.MEBIBYTES_PER_SECOND, SensorDeviceClass.DATA_RATE, SensorStateClass.MEASUREMENT, "mdi:upload-network", False),
    ("unas_disk_count", "Disks", None, None, SensorStateClass.MEASUREMENT, "mdi:harddisk", False),
    ("unas_disk_bays", "Drive Bays", None, None, None, "mdi:server", True),
    ("unas_disks_not_optimal", "Disks Not Optimal", None, None, SensorStateClass.MEASUREMENT, "mdi:harddisk-remove", False),
    ("unas_disk_temp_max", "Hottest Disk", UnitOfTemperature.CELSIUS, SensorDeviceClass.TEMPERATURE, SensorStateClass.MEASUREMENT, None, False),
    ("unas_disk_temp_min", "Coolest Disk", UnitOfTemperature.CELSIUS, SensorDeviceClass.TEMPERATURE, SensorStateClass.MEASUREMENT, None, False),
    ("unas_disk_power_on_hours_avg", "Average Disk Power-On Hours", UnitOfTime.HOURS, SensorDeviceClass.DURATION, SensorStateClass.MEASUREMENT, None, True),
]

# (metric, name, unit, state_class, icon)
SCRUB_SENSORS = [
    ("action", "Scrub State", None, None, "mdi:shield-sync"),
    ("mismatches", "Scrub Mismatches", None, SensorStateClass.MEASUREMENT, "mdi:shield-alert"),
    ("progress", "Scrub Progress", PERCENTAGE, SensorStateClass.MEASUREMENT, "mdi:progress-check"),
]

def nas_device(coordinator) -> DeviceInfo:
    name, model = get_device_info(coordinator.entry.data)
    return DeviceInfo(
        identifiers={(DOMAIN, coordinator.entry.entry_id)},
        name=name,
        manufacturer="Ubiquiti",
        model=model,
    )

def control_topic(coordinator, name: str) -> str:
    return f"{coordinator.mqtt_client.mqtt_root}/control/{CONTROL_TOPICS[name]}"

def _mqtt_data(coordinator) -> dict:
    return (coordinator.data or {}).get("mqtt_data", {})

class _ConsoleEntity(CoordinatorEntity):
    def __init__(self, coordinator, unique_suffix: str, name: str, icon: str | None = None) -> None:
        super().__init__(coordinator)
        self._attr_has_entity_name = True
        self._attr_name = name
        self._attr_unique_id = f"{coordinator.entry.entry_id}_{unique_suffix}"
        self._attr_device_info = nas_device(coordinator)
        if icon:
            self._attr_icon = icon

    @property
    def _data(self) -> dict:
        return _mqtt_data(self.coordinator)

# --- Binary sensors --------------------------------------------------------

class OnlineBinarySensor(_ConsoleEntity, BinarySensorEntity):
    """The console's online/offline badge: the agent's availability topic."""

    def __init__(self, coordinator) -> None:
        super().__init__(coordinator, "online", "Online")
        self._attr_device_class = BinarySensorDeviceClass.CONNECTIVITY

    @property
    def available(self) -> bool:
        return True

    @property
    def is_on(self) -> bool:
        return self.coordinator.mqtt_client.is_available()

class KeyBinarySensor(_ConsoleEntity, BinarySensorEntity):
    """On/off from a retained value, with an optional rule mapping it."""

    def __init__(self, coordinator, key, name, device_class=None, rule=None, icon=None, diagnostic=False):
        super().__init__(coordinator, key if rule is None else f"{key}_problem", name, icon)
        self._key = key
        self._rule = rule
        self._attr_device_class = device_class
        if diagnostic:
            self._attr_entity_category = EntityCategory.DIAGNOSTIC

    @property
    def available(self) -> bool:
        return self.coordinator.mqtt_client.is_available() and self._key in self._data

    @property
    def is_on(self) -> bool | None:
        raw = self._data.get(self._key)
        if self._rule is not None:
            return self._rule(raw)
        return str(raw).upper() == "ON"

class TimeMachineBinarySensor(KeyBinarySensor):
    def __init__(self, coordinator) -> None:
        super().__init__(coordinator, "unas_smb_time_machine", "Time Machine", icon="mdi:apple")

    @property
    def extra_state_attributes(self):
        shares = self._data.get("unas_smb_time_machine_attributes") or []
        ip = self._data.get("unas_net_ip")
        attrs = {"shares": shares}
        if ip:
            attrs["smb_address"] = f"smb://{ip}"
        return attrs

class BackupProblemBinarySensor(CoordinatorEntity, BinarySensorEntity):
    """`failed` (last run reported errors) or `overdue` (missed its schedule)."""

    def __init__(self, coordinator, task: dict, kind: str) -> None:
        super().__init__(coordinator)
        self._task_id = task["id"]
        self._kind = kind
        self._attr_has_entity_name = True
        self._attr_name = "Last run failed" if kind == "failed" else "Overdue"
        self._attr_unique_id = f"{coordinator.entry.entry_id}_backup_{self._task_id}_{kind}"
        self._attr_device_class = BinarySensorDeviceClass.PROBLEM
        self._attr_device_info = get_backup_device_info(coordinator.entry.entry_id, coordinator.entry.data, task)

    @property
    def available(self) -> bool:
        return self.coordinator.find_backup_task(self._task_id) is not None

    @property
    def is_on(self) -> bool:
        task = self.coordinator.find_backup_task(self._task_id) or {}
        if self._kind == "failed":
            return logic.backup_failed(task)
        return logic.backup_overdue(task, dt_util.utcnow())

    @property
    def extra_state_attributes(self):
        task = self.coordinator.find_backup_task(self._task_id) or {}
        last = task.get("lastTaskRun") or {}
        return {"error_codes": last.get("errorCodes") or [], "next_run": task.get("nextBackup")}

def console_binary_sensors(coordinator) -> list:
    return [OnlineBinarySensor(coordinator), TimeMachineBinarySensor(coordinator)]

def bay_binary_sensors(coordinator, bay: str) -> list:
    return [
        KeyBinarySensor(coordinator, f"unas_hdd_{bay}_present", f"Bay {bay} Drive Present", icon="mdi:harddisk"),
        KeyBinarySensor(
            coordinator,
            f"unas_hdd_{bay}_status",
            f"Bay {bay} Disk Problem",
            BinarySensorDeviceClass.PROBLEM,
            rule=logic.disk_problem,
        ),
    ]

def pool_binary_sensors(coordinator, pool: str) -> list:
    return [
        KeyBinarySensor(
            coordinator,
            f"unas_pool{pool}_protection",
            f"Storage Pool {pool} No Data Protection",
            BinarySensorDeviceClass.PROBLEM,
            rule=logic.pool_unprotected,
        )
    ]

def _has_mismatches(raw) -> bool | None:
    try:
        return int(raw) > 0
    except (TypeError, ValueError):
        return None


def scrub_binary_sensors(coordinator, array: str) -> list:
    return [
        KeyBinarySensor(coordinator, f"unas_scrub_{array}_running", f"Scrub {array} Running", BinarySensorDeviceClass.RUNNING),
        KeyBinarySensor(
            coordinator,
            f"unas_scrub_{array}_mismatches",
            f"Scrub {array} Found Errors",
            BinarySensorDeviceClass.PROBLEM,
            rule=_has_mismatches,
        ),
    ]

def backup_binary_sensors(coordinator, task: dict) -> list:
    return [BackupProblemBinarySensor(coordinator, task, "failed"), BackupProblemBinarySensor(coordinator, task, "overdue")]

# --- Select / button / event -----------------------------------------------

class FanProfileSelect(_ConsoleEntity, SelectEntity):
    """The console's Fan Mode (Quiet / Balanced / Cooling).

    It is the profile UniFi's own fan control follows, so it takes effect
    while the integration's Fan Mode select is on "UNAS Managed".
    """

    def __init__(self, coordinator) -> None:
        super().__init__(coordinator, "fan_profile", "Console Fan Profile", "mdi:fan-auto")
        self._attr_options = list(FAN_PROFILES)

    @property
    def available(self) -> bool:
        return self.coordinator.mqtt_client.is_available() and "unas_fan_profile" in self._data

    @property
    def current_option(self) -> str | None:
        value = self._data.get("unas_fan_profile")
        return value if value in FAN_PROFILES else None

    async def async_select_option(self, option: str) -> None:
        await mqtt.async_publish(self.hass, control_topic(self.coordinator, "fan_profile"), option, qos=1, retain=False)

class ScrubRunButton(_ConsoleEntity, ButtonEntity):
    """Storage Shield "Run Now": a read-only consistency check of every array."""

    def __init__(self, coordinator) -> None:
        super().__init__(coordinator, "scrub_run", "Run Scrub Now", "mdi:shield-refresh")

    @property
    def available(self) -> bool:
        data = self._data
        return self.coordinator.mqtt_client.is_available() and bool(logic.scrub_arrays_from_keys(data))

    async def async_press(self) -> None:
        await mqtt.async_publish(self.hass, control_topic(self.coordinator, "scrub_run"), "1", qos=1, retain=False)

class SignInEvent(_ConsoleEntity, EventEntity):
    """Fires once per new SMB session (who, from which IP, to which share)."""

    def __init__(self, coordinator) -> None:
        super().__init__(coordinator, "sign_in", "Sign-in", "mdi:account-arrow-right")
        self._attr_event_types = [SIGN_IN_EVENT]
        self._seen: set | None = None

    @callback
    def _handle_coordinator_update(self) -> None:
        clients = self._data.get("unas_smb_connections_attributes")
        if clients is not None:
            fresh, self._seen = logic.new_sessions(self._seen, clients)
            for client in fresh:
                self._trigger_event(
                    SIGN_IN_EVENT,
                    {
                        "username": client.get("username"),
                        "ip": client.get("ip"),
                        "share": client.get("share"),
                        "via": "smb",
                    },
                )
        self.async_write_ha_state()

def console_sensor_entities(coordinator, sensor_cls) -> list:
    out = []
    for key, name, unit, device_class, state_class, icon, diagnostic in CONSOLE_SENSORS:
        entity = sensor_cls(coordinator, key, name, unit, device_class, state_class, icon)
        if diagnostic:
            entity._attr_entity_category = EntityCategory.DIAGNOSTIC
        out.append(entity)
    return out

def scrub_sensor_entities(coordinator, sensor_cls, array: str) -> list:
    return [
        sensor_cls(coordinator, f"unas_scrub_{array}_{metric}", f"{name} {array}", unit, None, state_class, icon)
        for metric, name, unit, state_class, icon in SCRUB_SENSORS
    ]

async def discover_console_entities(coordinator) -> None:
    """Add per-bay, per-pool, per-array and per-backup entities as they appear.

    Called on every coordinator refresh; each set remembers what it already
    added so an entity is created once.
    """
    data = _mqtt_data(coordinator)
    seen = coordinator.console_seen
    binary_add = coordinator.binary_sensor_add_entities
    sensor_add = coordinator.sensor_add_entities

    if binary_add is not None:
        new = []
        for bay in logic.bays_from_keys(data):
            if ("bay", bay) not in seen:
                seen.add(("bay", bay))
                new.extend(bay_binary_sensors(coordinator, bay))
        for pool in logic.pools_with_protection(data):
            if ("pool", pool) not in seen:
                seen.add(("pool", pool))
                new.extend(pool_binary_sensors(coordinator, pool))
        for array in logic.scrub_arrays_from_keys(data):
            if ("scrub_bin", array) not in seen:
                seen.add(("scrub_bin", array))
                new.extend(scrub_binary_sensors(coordinator, array))
        for task in (coordinator.data or {}).get("backup_tasks", []):
            if ("backup", task["id"]) not in seen:
                seen.add(("backup", task["id"]))
                new.extend(backup_binary_sensors(coordinator, task))
        if new:
            binary_add(new)

    if sensor_add is not None:
        from .sensor import UNASSensor

        new = []
        for array in logic.scrub_arrays_from_keys(data):
            if ("scrub", array) not in seen:
                seen.add(("scrub", array))
                new.extend(scrub_sensor_entities(coordinator, UNASSensor, array))
        if new:
            sensor_add(new)
