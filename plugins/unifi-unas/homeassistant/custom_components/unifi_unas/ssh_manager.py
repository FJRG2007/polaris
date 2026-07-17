from __future__ import annotations

import asyncio
import json
import logging
import shlex
from pathlib import Path
from typing import Optional

import asyncssh

from .const import (
    AGENT_BINARY_REMOTE,
    AGENT_ENV_REMOTE,
    AGENT_SERVICE,
    AGENT_UNIT_REMOTE,
    HA_SSH_KEY_PATHS,
)

_LOGGER = logging.getLogger(__name__)

BIN_DIR = Path(__file__).parent / "bin"
SSH_CONNECT_TIMEOUT = 30

# Architectures we ship a prebuilt agent for. Keyed by `uname -m`.
SUPPORTED_ARCHES = {"aarch64", "x86_64"}

SYSTEMD_UNIT = """[Unit]
Description=Polaris UniFi UNAS agent (monitoring + fan control)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile={env}
ExecStart={binary}
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
""".format(env=AGENT_ENV_REMOTE, binary=AGENT_BINARY_REMOTE)


def _env_line(key: str, value: str) -> str:
    # systemd EnvironmentFile: quote and C-escape so passwords with spaces or
    # special characters survive intact.
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'{key}="{escaped}"'


class SSHManager:
    def __init__(
            self,
            host: str,
            username: str,
            password: Optional[str] = None,
            ssh_key: Optional[str] = None,
            port: int = 22,
            mqtt_host: Optional[str] = None,
            mqtt_user: Optional[str] = None,
            mqtt_password: Optional[str] = None,
            mqtt_port: int = 1883,
            mqtt_tls: bool = False,
            mqtt_tls_insecure: bool = False,
            scan_interval: int = 30,
    ) -> None:
        self.host = host
        self.username = username
        self.password = password
        self.ssh_key = ssh_key
        self.port = port
        self.mqtt_host = mqtt_host
        self.mqtt_user = mqtt_user
        self.mqtt_password = mqtt_password
        self.mqtt_port = mqtt_port
        self.mqtt_tls = mqtt_tls
        self.mqtt_tls_insecure = mqtt_tls_insecure
        self.scan_interval = scan_interval
        self._conn: Optional[asyncssh.SSHClientConnection] = None
        self._lock = asyncio.Lock()

    async def connect(self) -> None:
        async with self._lock:
            if self._conn:
                try:
                    await self._conn.run("true", timeout=2, check=False)
                    _LOGGER.debug("SSH connection reused")
                    return
                except asyncssh.Error:
                    _LOGGER.debug("SSH connection stale, reconnecting")
                except asyncio.TimeoutError:
                    _LOGGER.debug("SSH connection timed out, reconnecting")
                try:
                    self._conn.close()
                    await self._conn.wait_closed()
                except asyncssh.Error:
                    pass
                self._conn = None

            _LOGGER.debug("Establishing SSH connection to %s", self.host)

            client_keys = None
            if self.ssh_key:
                client_keys = [self.ssh_key]
            elif not self.password:
                for key_path in HA_SSH_KEY_PATHS:
                    if key_path.exists():
                        client_keys = [str(key_path)]
                        _LOGGER.debug("Using SSH key from %s", key_path)
                        break

            self._conn = await asyncio.wait_for(
                asyncssh.connect(
                    self.host,
                    port=self.port,
                    username=self.username,
                    password=self.password if self.password else None,
                    client_keys=client_keys,
                    known_hosts=None,
                ),
                timeout=SSH_CONNECT_TIMEOUT,
            )
            _LOGGER.debug("SSH connection established")

    async def disconnect(self) -> None:
        async with self._lock:
            if self._conn:
                self._conn.close()
                await self._conn.wait_closed()
                self._conn = None

    async def execute_command(self, command: str) -> tuple[str, str]:
        await self.connect()
        async with self._lock:
            if self._conn is None:
                raise ConnectionError("SSH connection not established")
            result = await self._conn.run(command, check=False)
        return getattr(result, "stdout", "") or "", getattr(result, "stderr", "") or ""

    async def scripts_installed(self) -> bool:
        # Kept the historical method name; it now checks the single agent binary
        # and its unit rather than the old Python/Bash scripts and their deps.
        safe_bin = shlex.quote(AGENT_BINARY_REMOTE)
        safe_unit = shlex.quote(AGENT_UNIT_REMOTE)
        stdout, _ = await self.execute_command(
            f"test -x {safe_bin} && test -f {safe_unit} && echo 'yes' || echo 'no'"
        )
        installed = stdout.strip() == "yes"
        _LOGGER.debug("Agent installed: %s", installed)
        return installed

    async def service_running(self, service_name: str) -> bool:
        safe_name = shlex.quote(service_name)
        stdout, _ = await self.execute_command(
            f"systemctl is-active {safe_name} 2>/dev/null || echo 'inactive'"
        )
        running = stdout.strip() == "active"
        _LOGGER.debug("Service %s running: %s", service_name, running)
        return running

    async def kick_native_fan_control(self) -> bool:
        # uhwd (native fan daemon) calculates PID values but doesn't write them to sysfs until it receives an
        # onFanProfileChanged event for some reason. Toggling the fan profile and back triggers this event, kicking uhwd
        # into active control mode.
        # Uses internal ustd APIs - returns False gracefully if they change.
        cmd = (
            "python3 -c '"
            "from ustd.tools.uhardware_fan import FanProfileManager; "
            "fpm = FanProfileManager(); "
            "cur = fpm.get_current_profile(); "
            "alt = \"quiet\" if cur != \"quiet\" else \"default\"; "
            "fpm.switch_profile(alt); "
            "fpm.switch_profile(cur); "
            "print(\"kicked\")' 2>&1"
        )
        stdout, _ = await self.execute_command(cmd)
        success = "kicked" in stdout
        if not success:
            _LOGGER.warning("Failed to kick native fan control: %s", stdout.strip())
        return success

    def _build_env_file(self, device_model: str, mqtt_root: str) -> str:
        lines = [
            _env_line("POLARIS_MQTT_HOST", self.mqtt_host or ""),
            _env_line("POLARIS_MQTT_PORT", str(int(self.mqtt_port))),
            _env_line("POLARIS_MQTT_USER", self.mqtt_user or ""),
            _env_line("POLARIS_MQTT_PASS", self.mqtt_password or ""),
            _env_line("POLARIS_MQTT_ROOT", mqtt_root),
            _env_line("POLARIS_MQTT_TLS", "true" if self.mqtt_tls else "false"),
            _env_line("POLARIS_MQTT_TLS_INSECURE", "true" if self.mqtt_tls_insecure else "false"),
            _env_line("POLARIS_DEVICE_MODEL", device_model),
            _env_line("POLARIS_MONITOR_INTERVAL", str(int(self.scan_interval))),
        ]
        return "\n".join(lines) + "\n"

    async def _detect_arch(self) -> str:
        stdout, _ = await self.execute_command("uname -m")
        arch = stdout.strip()
        if arch not in SUPPORTED_ARCHES:
            raise RuntimeError(f"Unsupported device architecture '{arch}'")
        return arch

    async def deploy_scripts(self, device_model: str, mqtt_root: str) -> None:
        # Deploys the single Rust agent binary plus its systemd unit and env
        # file. No packages are installed on the device.
        await self.connect()
        _LOGGER.info("Deploying agent for device model: %s", device_model)

        try:
            arch = await self._detect_arch()
            local_binary = BIN_DIR / f"polaris-unas-agent-{arch}"
            if not local_binary.exists():
                raise FileNotFoundError(
                    f"Prebuilt agent for '{arch}' not found at {local_binary}"
                )

            await self._put_binary(local_binary, AGENT_BINARY_REMOTE)
            await self._upload_text(AGENT_ENV_REMOTE, self._build_env_file(device_model, mqtt_root), mode=0o600)
            await self._upload_text(AGENT_UNIT_REMOTE, SYSTEMD_UNIT)

            await self.execute_command("systemctl daemon-reload")
            await self.execute_command(f"systemctl enable {shlex.quote(AGENT_SERVICE)}")
            await self.execute_command(f"systemctl restart {shlex.quote(AGENT_SERVICE)}")

            _LOGGER.info("Agent deployed and service started")

        except Exception as err:
            _LOGGER.error("Failed to deploy agent: %s", err)
            raise

    async def _put_binary(self, local_path: Path, remote_path: str) -> None:
        async with self._lock:
            if self._conn is None:
                raise ConnectionError("SSH connection not established")
            async with self._conn.start_sftp_client() as sftp:
                await sftp.put(str(local_path), remote_path)
        await self.execute_command(f"chmod +x {shlex.quote(remote_path)}")

    async def _upload_text(self, remote_path: str, content: str, mode: Optional[int] = None) -> None:
        async with self._lock:
            if self._conn is None:
                raise ConnectionError("SSH connection not established")
            async with self._conn.start_sftp_client() as sftp:
                async with sftp.open(remote_path, "w") as remote_file:
                    await remote_file.write(content)
        if mode is not None:
            await self.execute_command(f"chmod {mode:o} {shlex.quote(remote_path)}")

    async def execute_backup_api(self, method: str, endpoint: str) -> dict:
        cmd = f'''curl -s -X {method} "http://localhost:16080{endpoint}" \
            -H "X-UserId: $(jq -r '.[0].id' /data/unifi-core/config/cache/users.json)" \
            -H "X-UserRole: owner" \
            -H "X-UserAccessMask: 114654" \
            -H "X-UserPermissionMask: 16382"'''
        stdout, stderr = await self.execute_command(cmd)
        if not stdout.strip():
            _LOGGER.debug("Backup API returned empty response for %s %s", method, endpoint)
            return {}
        try:
            return json.loads(stdout)
        except json.JSONDecodeError as err:
            _LOGGER.warning("Failed to parse backup API response: %s", err)
            return {}

    async def update_backup_task(self, task_id: str, updates: dict) -> dict:
        payload = json.dumps(updates)
        escaped_payload = shlex.quote(payload)
        cmd = f'''curl -s -X PATCH "http://localhost:16080/api/v1/remote-backup/tasks/{task_id}" \
            -H "Content-Type: application/json" \
            -H "X-UserId: $(jq -r '.[0].id' /data/unifi-core/config/cache/users.json)" \
            -H "X-UserRole: owner" \
            -H "X-UserAccessMask: 114654" \
            -H "X-UserPermissionMask: 16382" \
            -d {escaped_payload}'''
        stdout, stderr = await self.execute_command(cmd)
        if not stdout.strip():
            return {}
        try:
            return json.loads(stdout)
        except json.JSONDecodeError as err:
            _LOGGER.warning("Failed to parse backup API update response: %s", err)
            return {}
