from pathlib import Path

from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo

# MQTT topic layout and device-model list are generated from polaris-unas-core
# (the on-device agent's single source of truth). Do not hand-edit _generated.py.
from ._generated import DEVICE_MODELS, get_mqtt_root, get_mqtt_topics

DOMAIN = "unifi_unas"

CONF_HOST = "host"

HA_SSH_KEY_PATHS = [
    Path("/config/.ssh/id_rsa"),
    Path("/config/.ssh/id_ed25519"),
    Path.home() / ".ssh" / "id_rsa",
    Path.home() / ".ssh" / "id_ed25519",
]
CONF_USERNAME = "username"
CONF_PASSWORD = "password"
CONF_MQTT_HOST = "mqtt_host"
CONF_MQTT_USER = "mqtt_user"
CONF_MQTT_PASSWORD = "mqtt_password"
CONF_MQTT_PORT = "mqtt_port"
CONF_MQTT_TLS = "mqtt_tls"
CONF_MQTT_TLS_INSECURE = "mqtt_tls_insecure"
CONF_SCAN_INTERVAL = "scan_interval"

DEFAULT_MQTT_PORT = 1883
DEFAULT_MQTT_TLS_PORT = 8883

DEFAULT_USERNAME = "root"
DEFAULT_SCAN_INTERVAL = 30
MIN_SCAN_INTERVAL = 5
MAX_SCAN_INTERVAL = 60

BACKUP_STATUS_IDLE = "idle"
BACKUP_STATUS_RUNNING = "in-progress"

ATTR_SCRIPTS_INSTALLED = "scripts_installed"
ATTR_SSH_CONNECTED = "ssh_connected"
ATTR_MONITOR_RUNNING = "monitor_running"
ATTR_FAN_CONTROL_RUNNING = "fan_control_running"

# On-device Polaris agent: one binary handles both monitoring and fan control.
AGENT_SERVICE = "polaris-unas-agent"
AGENT_BINARY_REMOTE = "/root/polaris-unas-agent"
AGENT_ENV_REMOTE = "/etc/polaris-unas-agent.env"
AGENT_UNIT_REMOTE = f"/etc/systemd/system/{AGENT_SERVICE}.service"

CONF_DEVICE_MODEL = "device_model"
CONF_DEVICE_NAME = "device_name"
DEFAULT_DEVICE_MODEL = "UNAS_PRO"


def get_device_info(entry_data: dict) -> tuple[str, str]:
    device_model = entry_data[CONF_DEVICE_MODEL]
    custom_name = entry_data.get(CONF_DEVICE_NAME)
    if device_model.startswith("UNVR"):
        return custom_name or "UNVR", "UniFi UNVR"
    return custom_name or "UNAS", "UniFi UNAS"


REMOTE_TYPE_LABELS = {
    "googleDrive": "Google Drive",
    "oneDrive": "OneDrive",
    "dropbox": "Dropbox",
    "s3": "Amazon S3",
    "sftp": "SFTP",
    "b2": "Backblaze B2",
    "wasabi": "Wasabi",
}


def format_remote_type(remote_type):
    if not remote_type:
        return "Local"
    return REMOTE_TYPE_LABELS.get(remote_type, remote_type.title())


def format_schedule(schedule):
    if not schedule or not schedule.get("enable"):
        return "Disabled"
    time = schedule.get("firstRunTime", "")
    weekdays = schedule.get("weekdays", "*")
    if weekdays == "*":
        return f"Daily at {time}"
    return f"{weekdays} at {time}"


def get_backup_device_info(entry_id: str, entry_data: dict, task: dict) -> DeviceInfo:
    remote = task.get("remote", {})
    device_name, _ = get_device_info(entry_data)
    return DeviceInfo(
        identifiers={(DOMAIN, f"{entry_id}_backup_{task['id']}")},
        name=f"{device_name} Backup {task['name']}",
        manufacturer=format_remote_type(remote.get("type")),
        model=remote.get("oauth2Account") or task.get("destinationDir", ""),
        entry_type=DeviceEntryType.SERVICE,
        via_device=(DOMAIN, entry_id),
    )
