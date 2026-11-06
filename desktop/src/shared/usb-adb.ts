/**
 * ADB over a USB cable, on WebUSB: find the ADB interface, claim it, and move
 * packets over its two bulk endpoints. The packets are the same as over TCP -
 * `adb-client.ts` speaks them; this only carries them.
 *
 * As AOSP's adb (client/usb_libusb.cpp) and Tango (@yume-chan/adb-daemon-webusb)
 * do it: the interface is class 0xFF, subclass 0x42, protocol 0x01; adbd sends
 * each packet as two transfers, the 24-byte header then the payload; and a
 * transfer out that fills its last USB packet exactly is followed by an empty
 * one, since a short packet is what ends a transfer.
 *
 * WebUSB is not in TypeScript's DOM library, so the little of it used here is
 * declared below.
 */

import type { TvUsbDevice } from "@/shared/bridge";

const HEADER_BYTES = 24;
const MAX_PAYLOAD = 1024 * 1024;
const NAME_LIMIT = 80;

export interface UsbEndpointLike {
    readonly endpointNumber: number;
    readonly direction: "in" | "out";
    readonly type: "bulk" | "interrupt" | "isochronous";
    readonly packetSize: number;
}

export interface UsbAlternateLike {
    readonly alternateSetting: number;
    readonly interfaceClass: number;
    readonly interfaceSubclass: number;
    readonly interfaceProtocol: number;
    readonly endpoints: readonly UsbEndpointLike[];
}

export interface UsbInterfaceLike {
    readonly interfaceNumber: number;
    readonly alternates: readonly UsbAlternateLike[];
}

export interface UsbConfigurationLike {
    readonly configurationValue: number;
    readonly interfaces: readonly UsbInterfaceLike[];
}

export interface UsbTransferInLike {
    readonly status: "ok" | "stall" | "babble";
    readonly data?: DataView;
}

export interface UsbDeviceLike {
    readonly vendorId: number;
    readonly productId: number;
    readonly serialNumber?: string;
    readonly productName?: string;
    readonly manufacturerName?: string;
    readonly configuration: UsbConfigurationLike | null;
    readonly configurations: readonly UsbConfigurationLike[];
    open(): Promise<void>;
    close(): Promise<void>;
    selectConfiguration(value: number): Promise<void>;
    claimInterface(number: number): Promise<void>;
    releaseInterface(number: number): Promise<void>;
    selectAlternateInterface(number: number, alternate: number): Promise<void>;
    transferIn(endpoint: number, length: number): Promise<UsbTransferInLike>;
    transferOut(endpoint: number, data: Uint8Array): Promise<unknown>;
}

export interface AdbUsbInterface {
    readonly configuration: number;
    readonly interfaceNumber: number;
    readonly alternate: number;
    readonly in: UsbEndpointLike;
    readonly out: UsbEndpointLike;
}

/** The device's ADB interface and its bulk endpoints, or null when it has none. */
export function adbInterface(device: UsbDeviceLike): AdbUsbInterface | null {
    const configurations = device.configuration
        ? [device.configuration, ...device.configurations]
        : device.configurations;
    for (const configuration of configurations) {
        for (const usbInterface of configuration.interfaces) {
            for (const alternate of usbInterface.alternates) {
                if (alternate.interfaceClass !== 0xff || alternate.interfaceSubclass !== 0x42) continue;
                if (alternate.interfaceProtocol !== 0x01) continue;
                const bulk = (direction: "in" | "out") =>
                    alternate.endpoints.find((one) => one.type === "bulk" && one.direction === direction);
                const inbound = bulk("in");
                const outbound = bulk("out");
                if (!inbound || !outbound) continue;
                return {
                    configuration: configuration.configurationValue,
                    interfaceNumber: usbInterface.interfaceNumber,
                    alternate: alternate.alternateSetting,
                    in: inbound,
                    out: outbound
                };
            }
        }
    }
    return null;
}

function readable(text: string | undefined): string {
    return (text ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

/** The devices offering ADB, each under an id that stays the same while it is plugged in. */
export function describeDevices(devices: readonly UsbDeviceLike[]): Array<{ readonly id: string; readonly device: UsbDeviceLike; readonly info: TvUsbDevice; }> {
    const hex = (value: number) => value.toString(16).padStart(4, "0");
    return devices
        .filter((device) => adbInterface(device) !== null)
        .map((device, index) => {
            const serial = readable(device.serialNumber);
            const id = serial ? `s:${serial}` : `d:${hex(device.vendorId)}:${hex(device.productId)}:${index}`;
            const label = [readable(device.manufacturerName), readable(device.productName)].filter(Boolean).join(" ");
            const name = (label || "Android device").slice(0, NAME_LIMIT);
            return { id: id.slice(0, NAME_LIMIT * 2), device, info: { id: id.slice(0, NAME_LIMIT * 2), name } };
        });
}

/** Why a device could not be opened: the only two things the screen can say. */
export class UsbOpenError extends Error {
    constructor(readonly reason: "busy" | "gone") {
        super(reason);
    }
}

export interface UsbAdbPipe {
    /** Queues one packet; transfers go out in the order they were queued. */
    send(header: Uint8Array, data: Uint8Array): void;
    close(): Promise<void>;
}

/**
 * Opens and claims the device's ADB interface, then reads packets until it is
 * closed or lost. `onLost` is called once, and never after `close`.
 */
export async function openAdbPipe(
    device: UsbDeviceLike,
    onPacket: (bytes: Uint8Array) => void,
    onLost: () => void
): Promise<UsbAdbPipe> {
    const found = adbInterface(device);
    if (!found) throw new UsbOpenError("gone");
    try {
        await device.open();
        if (device.configuration?.configurationValue !== found.configuration) {
            await device.selectConfiguration(found.configuration);
        }
        // On Windows a claimed interface - a running adb server holds it - or one
        // with no WinUSB driver fails here.
        await device.claimInterface(found.interfaceNumber);
        if (found.alternate !== 0) await device.selectAlternateInterface(found.interfaceNumber, found.alternate);
    } catch (caught) {
        await device.close().catch(() => undefined);
        throw new UsbOpenError((caught as { name?: string; }).name === "NotFoundError" ? "gone" : "busy");
    }

    let open = true;
    const lose = () => {
        if (!open) return;
        open = false;
        void device.close().catch(() => undefined);
        onLost();
    };
    const zeroMask = found.out.packetSize - 1;
    let queue: Promise<unknown> = Promise.resolve();
    const transfer = async (bytes: Uint8Array) => {
        if (bytes.length === 0) return;
        await device.transferOut(found.out.endpointNumber, bytes);
        if (zeroMask > 0 && (bytes.length & zeroMask) === 0) {
            await device.transferOut(found.out.endpointNumber, new Uint8Array(0));
        }
    };

    void (async () => {
        try {
            while (open) {
                const head = await device.transferIn(found.in.endpointNumber, Math.max(found.in.packetSize, HEADER_BYTES));
                if (!open) return;
                if (head.status !== "ok" || !head.data || head.data.byteLength !== HEADER_BYTES) throw new Error("framing");
                const length = head.data.getUint32(12, true);
                if (length > MAX_PAYLOAD) throw new Error("framing");
                const packet = new Uint8Array(HEADER_BYTES + length);
                packet.set(new Uint8Array(head.data.buffer, head.data.byteOffset, HEADER_BYTES), 0);
                let at = HEADER_BYTES;
                while (at < packet.length) {
                    const body = await device.transferIn(found.in.endpointNumber, packet.length - at);
                    if (!open) return;
                    if (body.status !== "ok" || !body.data || body.data.byteLength === 0) throw new Error("framing");
                    const piece = new Uint8Array(body.data.buffer, body.data.byteOffset, Math.min(body.data.byteLength, packet.length - at));
                    packet.set(piece, at);
                    at += piece.length;
                }
                onPacket(packet);
            }
        } catch {
            lose();
        }
    })();

    return {
        send(header, data) {
            if (!open) return;
            queue = queue.then(() => transfer(header)).then(() => transfer(data)).catch(lose);
        },
        async close() {
            if (!open) return;
            open = false;
            await device.releaseInterface(found.interfaceNumber).catch(() => undefined);
            await device.close().catch(() => undefined);
        }
    };
}
