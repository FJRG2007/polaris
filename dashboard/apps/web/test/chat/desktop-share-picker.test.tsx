// @vitest-environment jsdom

/**
 * The desktop app's share picker: open at once with placeholder tiles while the
 * app lists what can be shared, names first and pictures after; Discord's three
 * groups (applications, entire screen, capture devices); pictures of the tab
 * on screen only; a tile shares at once; the stream's mode, definition and
 * sound in the bar under the tiles; closing it shares nothing.
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
    mergeKind,
    pickDesktopShare
} from "@/app/(app)/chat/desktop-share-picker";
import { STREAM_PREFS_DEFAULT, setStreamPrefs, streamPrefs } from "@/app/(app)/chat/stream-shape";

/** Radix opens a menu on a pointer press, which jsdom has to be told about. */
function openSettings(): void {
    const trigger = screen.getByRole("button", { name: "Stream settings" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
}

/** Close an open menu the way a key press would. */
function closeMenu(): void {
    const menu = screen.queryByRole("menu");
    if (menu) fireEvent.keyDown(menu, { key: "Escape" });
}

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

afterEach(() => {
    cleanup();
    setStreamPrefs(STREAM_PREFS_DEFAULT);
});

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

    it("opens before the list arrives, then asks for names and the pictures of the tab on screen", async () => {
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
        await waitFor(() =>
            expect(bridge.shareSources).toHaveBeenCalledWith({ thumbnails: true, kind: "window" })
        );
        // Only the screens are filmed once their tab is open.
        expect(bridge.shareSources).not.toHaveBeenCalledWith({ thumbnails: true, kind: "screen" });
        fireEvent.click(screen.getByRole("radio", { name: "Entire Screen" }));
        await waitFor(() =>
            expect(bridge.shareSources).toHaveBeenCalledWith({ thumbnails: true, kind: "screen" })
        );
    });

    it("shares an application at once from its tile, with the computer's sound", async () => {
        const picked = openPicker();
        fireEvent.click(await screen.findByRole("button", { name: /Notes/ }));
        await expect(picked).resolves.toEqual({ kind: "source", id: "window:42:0", sound: true });
    });

    it("lists screens on the entire-screen tab", async () => {
        const picked = openPicker();
        await screen.findByRole("button", { name: /Notes/ });
        expect(screen.queryByRole("button", { name: /Screen 1/ })).toBeNull();
        fireEvent.click(screen.getByRole("radio", { name: "Entire Screen" }));
        fireEvent.click(screen.getByRole("button", { name: /Screen 1/ }));
        await expect(picked).resolves.toEqual({ kind: "source", id: "screen:0:0", sound: true });
    });

    it("mutes the stream's sound from the settings beside the tiles", async () => {
        const picked = openPicker();
        await screen.findByRole("button", { name: /Notes/ });
        openSettings();
        fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Mute stream audio" }));
        closeMenu();
        fireEvent.click(screen.getByRole("button", { name: /Notes/ }));
        await expect(picked).resolves.toEqual({ kind: "source", id: "window:42:0", sound: false });
    });

    it("picks a stream mode and a definition, and says how it will go out", async () => {
        void openPicker();
        await screen.findByRole("button", { name: /Notes/ });
        expect(screen.getByText("Automatic")).toBeTruthy();
        openSettings();
        fireEvent.click(await screen.findByRole("menuitemradio", { name: /Gaming/ }));
        expect(streamPrefs().shape).toEqual({ frameRate: 30, resolution: 720 });
        closeMenu();
        expect(screen.getByText("Smoother video - 720p - 30 FPS")).toBeTruthy();
        fireEvent.click(screen.getByRole("radio", { name: "HD" }));
        expect(streamPrefs().shape).toEqual({ frameRate: 30, resolution: 1080 });
    });

    it("shares a capture device, with its own sound when asked", async () => {
        const picked = openPicker();
        fireEvent.click(screen.getByRole("radio", { name: "Devices" }));
        await screen.findByRole("button", { name: /Capture card/ });
        openSettings();
        // The computer's sound is not the device's.
        expect(screen.queryByRole("menuitemcheckbox", { name: "Mute stream audio" })).toBeNull();
        fireEvent.click(
            await screen.findByRole("menuitemcheckbox", { name: "Share the device's sound" })
        );
        closeMenu();
        fireEvent.click(screen.getByRole("button", { name: /Capture card/ }));
        await expect(picked).resolves.toEqual({ kind: "device", deviceId: "cam-1", audioId: "mic-1" });
    });

    it("hands back to the app's own picker when it lists nothing", async () => {
        bridge = { platform: "win32", shareSources: vi.fn(async () => null) } as unknown as PolarisDesktop;
        await expect(openPicker()).resolves.toEqual({ kind: "system" });
    });

    it("resolves null when it is closed", async () => {
        const picked = openPicker();
        fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
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

    it("replaces one kind's listing and keeps the other's, screens first", () => {
        const pictured: DesktopShareSources = {
            sound: true,
            sources: [
                { ...listed.sources[0]!, thumbnail: "data:screen" },
                { ...listed.sources[1]!, thumbnail: "data:window-old" }
            ]
        };
        const windowsOnly: DesktopShareSources = {
            sound: true,
            sources: [{ ...listed.sources[1]!, thumbnail: "data:window-new" }]
        };
        expect(mergeKind(windowsOnly, pictured, "window").sources.map((source) => source.thumbnail)).toEqual([
            "data:screen",
            "data:window-new"
        ]);
        // An app that ignores the kind sends both; only the asked kind is taken.
        expect(mergeKind(pictured, null, "screen").sources.map((source) => source.id)).toEqual(["screen:0:0"]);
    });

    it("pairs a device with its own audio input, never a Windows alias", () => {
        expect(captureDevices(devices)).toEqual([{ id: "cam-1", name: "Capture card", audioId: "mic-1" }]);
        expect(captureDevices([device("videoinput", "cam-2", "", "g9")])).toEqual([
            { id: "cam-2", name: "", audioId: null }
        ]);
    });
});
