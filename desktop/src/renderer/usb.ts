/**
 * The hidden page that holds a TV's USB connection. WebUSB lives in a page, not
 * in the main process, so this one lists the devices, opens the one asked for,
 * and passes its packets back and forth. It draws nothing.
 */

import type { UsbBridge, UsbReply } from "@/shared/bridge";
import { describeDevices, openAdbPipe, UsbOpenError, type UsbAdbPipe, type UsbDeviceLike } from "@/shared/usb-adb";

interface UsbLike extends EventTarget {
    getDevices(): Promise<UsbDeviceLike[]>;
}

declare global {
    interface Window {
        readonly polarisUsb: UsbBridge;
    }
}

const usb = (navigator as Navigator & { readonly usb?: UsbLike; }).usb;
const bridge = window.polarisUsb;
let known = new Map<string, UsbDeviceLike>();
let pipe: { readonly device: UsbDeviceLike; readonly pipe: UsbAdbPipe; } | null = null;

async function shut(): Promise<void> {
    const open = pipe;
    pipe = null;
    await open?.pipe.close();
}

usb?.addEventListener("disconnect", (event) => {
    const gone = (event as Event & { readonly device?: UsbDeviceLike; }).device;
    if (pipe && gone === pipe.device) {
        pipe = null;
        bridge.lost();
    }
});

bridge.onOut((header, data) => pipe?.pipe.send(header, data));

async function refresh(): Promise<ReturnType<typeof describeDevices>> {
    const described = describeDevices(usb ? await usb.getDevices() : []);
    known = new Map(described.map((one) => [one.id, one.device]));
    return described;
}

bridge.onRequest((request) => {
    void (async (): Promise<UsbReply> => {
        if (request.op === "list") {
            const described = await refresh();
            return { id: request.id, ok: true, devices: described.map((one) => one.info) };
        }
        await shut();
        if (request.op === "close") return { id: request.id, ok: true };
        if (!known.has(request.device)) await refresh();
        const device = known.get(request.device);
        if (!device) return { id: request.id, ok: false, error: "gone" };
        try {
            const opened = await openAdbPipe(
                device,
                (bytes) => bridge.received(bytes),
                () => {
                    if (pipe?.device !== device) return;
                    pipe = null;
                    bridge.lost();
                }
            );
            pipe = { device, pipe: opened };
            return { id: request.id, ok: true };
        } catch (caught) {
            return { id: request.id, ok: false, error: caught instanceof UsbOpenError ? caught.reason : "busy" };
        }
    })()
        .catch((): UsbReply => ({ id: request.id, ok: false, error: "busy" }))
        .then((reply) => bridge.reply(reply));
});
