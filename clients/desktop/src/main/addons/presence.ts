/**
 * Which USB devices are plugged in, and word when that changes - with no
 * polling: an add-on whose device is unplugged has no process at all, and is
 * started again by the plug event.
 *
 * Linux reads sysfs and hears /dev/bus/usb change through inotify. Windows and
 * macOS ask the Rust core's Node binding (crates/polaris-core-node/src/usb.rs,
 * nusb), which sleeps on the operating system's own plug notification. Where
 * that binding is missing or predates USB presence, `watchUsb` answers null
 * ("not known") and every installed add-on runs as if its device were present.
 */

import { z } from "zod";
import { join } from "node:path";
import type { UsbDevice } from "@polaris/core/device-addons";
import { nativeUsb, type NativeUsb } from "@polaris/core-rs/native";
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

const nativeListSchema = z
    .array(z.object({ vendorId: z.number().int().min(0).max(0xffff), productId: z.number().int().min(0).max(0xffff) }))
    .max(1024);

/** The binding's list, checked; null when it fails or answers something else. */
export function listNativeUsb(usb: Pick<NativeUsb, "usbDevicesJson">): UsbDevice[] | null {
    try {
        const parsed = nativeListSchema.safeParse(JSON.parse(usb.usbDevicesJson()));
        return parsed.success ? parsed.data.map(({ vendorId, productId }) => ({ vendorId, productId })) : null;
    } catch {
        return null;
    }
}

/** Plugs and unplugs from the binding; a plug is several events at once, so the list is read once they settle. */
export function watchNativeUsb(onChange: (devices: UsbDevice[]) => void, usb: NativeUsb): UsbWatch | null {
    const first = listNativeUsb(usb);
    if (!first) return null;
    let last: UsbDevice[] = first;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let handle: { close(): void };
    try {
        handle = usb.watchUsb(() => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                const next = listNativeUsb(usb);
                if (next) {
                    last = next;
                    onChange(next);
                }
            }, 300);
        });
    } catch {
        return null;
    }
    return {
        list: () => {
            const next = listNativeUsb(usb);
            if (next) last = next;
            return last;
        },
        close: () => {
            if (timer) clearTimeout(timer);
            handle.close();
        }
    };
}

/** Watch for plugs and unplugs; null where devices cannot be listed (see above). */
export function watchUsb(
    onChange: (devices: UsbDevice[]) => void,
    platform = process.platform,
    loadNative: () => NativeUsb | null = nativeUsb
): UsbWatch | null {
    if (platform !== "linux") {
        const usb = loadNative();
        return usb ? watchNativeUsb(onChange, usb) : null;
    }
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
