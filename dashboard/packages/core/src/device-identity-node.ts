/**
 * Reads this computer's identity for a native client: the hashed machine id the
 * sessions screen groups by (`./device-identity`), the computer's name and the
 * system's version.
 *
 * Imported by path, not through the package, by Polaris Desktop, the command
 * line and the Stream Deck plugin - the same way they share
 * `./instance-fallback` - so the three derive the very same value on one
 * computer. Not exported from the package index: it uses Node built-ins and the
 * dashboard bundles the index for the browser.
 *
 * The machine id comes from the operating system (Windows' MachineGuid, macOS'
 * IOPlatformUUID, systemd's machine-id). It is never sent as-is: it is hashed
 * with a fixed label first, so the value that leaves the computer cannot be
 * turned back into the id or matched against another program's use of it.
 */

import os from "node:os";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { DEVICE_NAME_MAX, readDeviceName } from "./device-identity.js";

/** What a client reports about the computer it runs on. */
export interface DeviceIdentity {
    /** The hashed machine id, or null when the system would not give one. */
    readonly id: string | null;
    /** The computer's name, or null when it has none worth showing. */
    readonly name: string | null;
    /** The system's own description of its version ("Windows 11 Pro"). */
    readonly osVersion: string | null;
}

/** Fixed label so this hash means "Polaris device" and nothing else. */
const LABEL = "polaris-device-v1";

/** The identifier sent for a raw machine id. */
export function deviceIdFrom(machineId: string): string {
    return createHash("sha256")
        .update(`${LABEL}\u0000${machineId.trim().toLowerCase()}`)
        .digest("hex");
}

/** MachineGuid out of `reg query` output. */
export function parseWindowsMachineGuid(output: string): string | null {
    return /MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]{32,36})/.exec(output)?.[1] ?? null;
}

/** IOPlatformUUID out of `ioreg -rd1 -c IOPlatformExpertDevice` output. */
export function parseMacPlatformUuid(output: string): string | null {
    return /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{32,36})"/.exec(output)?.[1] ?? null;
}

/** A machine-id file's contents, when it holds one. */
export function parseMachineIdFile(contents: string): string | null {
    const value = contents.trim();
    return /^[0-9A-Fa-f-]{8,64}$/.test(value) ? value : null;
}

/** A program's output, or "" when it could not run. Argument array, no shell. */
function run(command: string, args: readonly string[]): Promise<string> {
    return new Promise((resolve) => {
        execFile(command, [...args], { windowsHide: true, timeout: 3000 }, (error, stdout) =>
            resolve(error ? "" : String(stdout))
        );
    });
}

async function readMachineId(): Promise<string | null> {
    if (process.platform === "win32") {
        // /reg:64 so a 32-bit runtime reads the key and not its empty redirect.
        const output = await run("reg", [
            "query",
            "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
            "/v",
            "MachineGuid",
            "/reg:64"
        ]);
        return parseWindowsMachineGuid(output);
    }
    if (process.platform === "darwin") {
        return parseMacPlatformUuid(await run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]));
    }
    for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id", "/etc/hostid"]) {
        const contents = await readFile(file, "utf8").catch(() => "");
        const id = parseMachineIdFile(contents);
        if (id) return id;
    }
    return null;
}

let cached: Promise<DeviceIdentity> | null = null;

/** This computer's identity, read once per process. Never throws. */
export function deviceIdentity(): Promise<DeviceIdentity> {
    cached ??= readMachineId()
        .catch(() => null)
        .then((machineId) => ({
            id: machineId ? deviceIdFrom(machineId) : null,
            name: readDeviceName(os.hostname().slice(0, DEVICE_NAME_MAX)),
            osVersion: readDeviceName(
                typeof os.version === "function" ? os.version() : os.release()
            )
        }));
    return cached;
}
