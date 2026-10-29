// @vitest-environment jsdom

/**
 * The desktop app's share picker: open at once with placeholder tiles while the
 * app lists what can be shared, names first and pictures after; Discord's three
 * groups (applications, entire screen, capture devices); Share only once
 * something is picked; closing it shares nothing.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DesktopShareSources, PolarisDesktop } from "@/lib/desktop-bridge";
import {
    DesktopSharePickerHost,
    canPickDesktopShare,
    captureDevices,
    keepPictures,
    pickDesktopShare
} from "@/app/(app)/chat/desktop-share-picker";

const listed: DesktopShareSources = {
    sound: true,
    sources: [
        { id: "screen:0:0", name: "Screen 1", kind: "screen", thumbnail: null, icon: null },
        { id: "window:42:0", name: "Notes", kind: "window", thumbnail: null, icon: null }
    ]
};

const device = (kind: MediaDeviceKind, deviceId: string, label: string, groupId: string) =>
    ({ kind, deviceId, label, groupId }) as MediaDeviceInfo;

const devices = [
    device("videoinput", "cam-1", "Capture card", "g1"),
    device("audioinput", "default", "Default", "g1"),
    device("audioinput", "mic-1", "Capture card audio", "g1"),
    device("audioinput", "mic-2", "Headset", "g2")
];

let bridge: PolarisDesktop;

beforeEach(() => {
    bridge = { platform: "win32", shareSources: vi.fn(async () => listed) } as unknown as PolarisDesktop;
    Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
            enumerateDevices: vi.fn(async () => devices),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn()
        }
    });
});

afterEach(cleanup);

function openPicker(): Promise<unknown> {
    render(<DesktopSharePickerHost />, { wrapper: MessagesWrapper });
    let picked: Promise<unknown> = Promise.resolve();
    act(() => {
        picked = pickDesktopShare(bridge);
    });
    return picked;
}

describe("desktop share picker", () => {
    it("is only offered while a host is mounted", () => {
        expect(canPickDesktopShare()).toBe(false);
        render(<DesktopSharePickerHost />, { wrapper: MessagesWrapper });
        expect(canPickDesktopShare()).toBe(true);
    });

    it("opens before the list arrives, then asks for names and pictures", async () => {
        let answer: (value: DesktopShareSources) => void = () => undefined;
        bridge = {
            platform: "win32",
            shareSources: vi.fn(
                (input?: { thumbnails?: boolean }) =>
                    new Promise<DesktopShareSources>((resolve) => {
                        if (input?.thumbnails === false) answer = resolve;
                        else resolve(listed);
                    })
            )
        } as unknown as PolarisDesktop;
        void openPicker();
        expect(screen.getByRole("dialog")).toBeTruthy();
        expect(screen.getByRole("list", { name: "Finding what you can share" })).toBeTruthy();
        expect(bridge.shareSources).toHaveBeenCalledWith({ thumbnails: false });
        await act(async () => answer(listed));
        expect(screen.getByRole("button", { name: /Notes/ })).toBeTruthy();
        await waitFor(() => expect(bridge.shareSources).toHaveBeenCalledWith({ thumbnails: true }));
    });

    it("offers applications first and resolves with the pick and the sound choice", async () => {
        const picked = openPicker();
        // Share does nothing before a pick.
        fireEvent.click(screen.getByRole("button", { name: "Start sharing" }));
        fireEvent.click(await screen.findByRole("button", { name: /Notes/ }));
        expect(screen.queryByRole("button", { name: /Screen 1/ })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Start sharing" }));
        await expect(picked).resolves.toEqual({ kind: "source", id: "window:42:0", sound: true });
    });

    it("lists screens on the entire-screen tab", async () => {
        const picked = openPicker();
        await screen.findByRole("button", { name: /Notes/ });
        fireEvent.click(screen.getByRole("radio", { name: "Entire Screen" }));
        fireEvent.click(screen.getByRole("button", { name: /Screen 1/ }));
        fireEvent.click(screen.getByRole("button", { name: "Start sharing" }));
        await expect(picked).resolves.toEqual({ kind: "source", id: "screen:0:0", sound: true });
    });

    it("shares a capture device, with its own sound when asked", async () => {
        const picked = openPicker();
        fireEvent.click(screen.getByRole("radio", { name: "Devices" }));
        fireEvent.click(await screen.findByRole("button", { name: /Capture card/ }));
        // The computer's sound is not the device's.
        expect(screen.queryByRole("switch", { name: "Share this computer's sound" })).toBeNull();
        fireEvent.click(screen.getByRole("switch", { name: "Share the device's sound" }));
        fireEvent.click(screen.getByRole("button", { name: "Start sharing" }));
        await expect(picked).resolves.toEqual({ kind: "device", deviceId: "cam-1", audioId: "mic-1" });
    });

    it("hands back to the app's own picker when it lists nothing", async () => {
        bridge = { platform: "win32", shareSources: vi.fn(async () => null) } as unknown as PolarisDesktop;
        await expect(openPicker()).resolves.toEqual({ kind: "system" });
    });

    it("resolves null when it is closed", async () => {
        const picked = openPicker();
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        await expect(picked).resolves.toBeNull();
    });
});

describe("what the picker keeps and finds", () => {
    it("keeps the pictures a names-only list does not carry", () => {
        const before: DesktopShareSources = {
            sound: true,
            sources: [{ ...listed.sources[1]!, thumbnail: "data:image/jpeg;base64,AA==", icon: "data:x" }]
        };
        const merged = keepPictures(listed, before);
        expect(merged.sources[1]).toMatchObject({ thumbnail: "data:image/jpeg;base64,AA==", icon: "data:x" });
        expect(merged.sources[0]?.thumbnail).toBeNull();
    });

    it("pairs a device with its own audio input, never a Windows alias", () => {
        expect(captureDevices(devices)).toEqual([{ id: "cam-1", name: "Capture card", audioId: "mic-1" }]);
        expect(captureDevices([device("videoinput", "cam-2", "", "g9")])).toEqual([
            { id: "cam-2", name: "", audioId: null }
        ]);
    });
});
