import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeUsb } from "@polaris/core-rs/native";
import { listNativeUsb, watchUsb } from "@/main/addons/presence";

const HERCULES = { vendorId: 0x06f8, productId: 0xe053 };

/** A binding stand-in: `plug` changes the list and fires the watch, as the OS notification would. */
function fakeBinding(initial: { vendorId: number; productId: number }[]) {
    let devices = initial;
    let fire: ((count: number) => void) | null = null;
    const close = vi.fn();
    const usb: NativeUsb = {
        usbDevicesJson: () => JSON.stringify(devices),
        watchUsb: (onChange) => {
            fire = onChange;
            return { close };
        }
    };
    return {
        usb,
        close,
        plug(next: typeof devices) {
            devices = next;
            fire?.(1);
            fire?.(2);
        }
    };
}

afterEach(() => vi.useRealTimers());

describe("native USB presence (Windows, macOS)", () => {
    it("lists what the binding reports and hears a plug once it settles", () => {
        vi.useFakeTimers();
        const binding = fakeBinding([]);
        const seen: unknown[] = [];
        const watch = watchUsb((devices) => seen.push(devices), "win32", () => binding.usb);
        expect(watch?.list()).toEqual([]);
        binding.plug([HERCULES]);
        expect(seen).toEqual([]);
        vi.advanceTimersByTime(300);
        expect(seen).toEqual([[HERCULES]]);
        expect(watch?.list()).toEqual([HERCULES]);
        watch?.close();
        expect(binding.close).toHaveBeenCalledOnce();
    });

    it("answers not known without a binding, or with one built before USB presence", () => {
        expect(watchUsb(() => {}, "darwin", () => null)).toBeNull();
        const broken: NativeUsb = { usbDevicesJson: () => "not json", watchUsb: () => ({ close() {} }) };
        expect(watchUsb(() => {}, "win32", () => broken)).toBeNull();
    });

    it("refuses a list that is not ids", () => {
        expect(listNativeUsb({ usbDevicesJson: () => JSON.stringify([{ vendorId: 70000, productId: 1 }]) })).toBeNull();
        expect(listNativeUsb({ usbDevicesJson: () => JSON.stringify({ vendorId: 1 }) })).toBeNull();
        expect(listNativeUsb({ usbDevicesJson: () => { throw new Error("gone"); } })).toBeNull();
        expect(listNativeUsb({ usbDevicesJson: () => JSON.stringify([HERCULES]) })).toEqual([HERCULES]);
    });

    it("keeps the last good list when a read after a plug fails", () => {
        vi.useFakeTimers();
        let fail = false;
        let fire: (() => void) | null = null;
        const usb: NativeUsb = {
            usbDevicesJson: () => {
                if (fail) throw new Error("busy");
                return JSON.stringify([HERCULES]);
            },
            watchUsb: (onChange) => {
                fire = () => onChange(1);
                return { close() {} };
            }
        };
        const onChange = vi.fn();
        const watch = watchUsb(onChange, "win32", () => usb);
        fail = true;
        fire!();
        vi.advanceTimersByTime(300);
        expect(onChange).not.toHaveBeenCalled();
        expect(watch?.list()).toEqual([HERCULES]);
    });
});
