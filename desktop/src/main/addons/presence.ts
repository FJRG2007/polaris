/**
 * Which USB devices are plugged in, and word when that changes - with no
 * polling: an add-on whose device is unplugged has no process at all, and is
 * started again by the plug event.
 *
 * Linux reads sysfs and hears /dev/bus/usb change through inotify. Windows and
 * macOS have no way to list USB devices from Node without native code; until a
 * native watcher ships there, `watchUsb` answers null ("not known") and every
 * installed add-on runs as if its device were present, watching for it itself.
 */

import { join } from "node:path";
import type { UsbDevice } from "@polaris/core/device-addons";
import { readdirSync, readFileSync, watch, type FSWatcher } from "node:fs";

const SYSFS = "/sys/bus/usb/devices";
const DEVFS = "/dev/bus/usb";

/** The id in a sysfs `idVendor`/`idProduct` file ("06f8\n"), or null. */
export function readUsbId(text: string): number | null {
    const trimmed = text.trim();
    return /^[0-9a-fA-F]{4}$/.test(trimmed) ? Number.parseInt(trimmed, 16) : null;
}

/** Devices listed by sysfs, one per device (interfaces carry no ids and are skipped). */
export function listLinuxUsb(root = SYSFS): UsbDevice[] {
    const out: UsbDevice[] = [];
    let names: string[];
    try {
        names = readdirSync(root);
    } catch {
        return out;
    }
    for (const name of names) {
        try {
            const vendorId = readUsbId(readFileSync(join(root, name, "idVendor"), "utf8"));
            const productId = readUsbId(readFileSync(join(root, name, "idProduct"), "utf8"));
            if (vendorId !== null && productId !== null) out.push({ vendorId, productId });
        } catch {
            // An interface, or a device unplugged while being read.
        }
    }
    return out;
}

export interface UsbWatch {
    readonly list: () => UsbDevice[];
    readonly close: () => void;
}

/** Watch for plugs and unplugs; null where devices cannot be listed (see above). */
export function watchUsb(onChange: (devices: UsbDevice[]) => void, platform = process.platform): UsbWatch | null {
    if (platform !== "linux") return null;
    let watcher: FSWatcher | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
        watcher = watch(DEVFS, { recursive: true, persistent: false }, () => {
            // A plug is several events at once; read once they settle.
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => onChange(listLinuxUsb()), 300);
        });
    } catch {
        return null;
    }
    return {
        list: () => listLinuxUsb(),
        close: () => {
            if (timer) clearTimeout(timer);
            watcher?.close();
        }
    };
}
