// @vitest-environment jsdom

/**
 * The desktop app's share picker: screens first, Share only once something is
 * picked, and closing it shares nothing.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DesktopShareSources, PolarisDesktop } from "@/lib/desktop-bridge";
import { DesktopSharePickerHost, canPickDesktopShare, pickDesktopShare } from "@/app/(app)/chat/desktop-share-picker";

const listed: DesktopShareSources = {
    sound: true,
    sources: [
        { id: "screen:0:0", name: "Screen 1", kind: "screen", thumbnail: null, icon: null },
        { id: "window:42:0", name: "Notes", kind: "window", thumbnail: null, icon: null }
    ]
};

const bridge = { shareSources: vi.fn(async () => listed) } as unknown as PolarisDesktop;

afterEach(cleanup);

describe("desktop share picker", () => {
    it("is only offered while a host is mounted", () => {
        expect(canPickDesktopShare()).toBe(false);
        render(<DesktopSharePickerHost />, { wrapper: MessagesWrapper });
        expect(canPickDesktopShare()).toBe(true);
    });

    it("resolves with the picked source and the sound choice", async () => {
        render(<DesktopSharePickerHost />, { wrapper: MessagesWrapper });
        let picked: Promise<unknown> = Promise.resolve();
        act(() => {
            picked = pickDesktopShare(bridge, listed);
        });
        // Share does nothing before a pick.
        fireEvent.click(screen.getByRole("button", { name: "Start sharing" }));
        fireEvent.click(screen.getByRole("button", { name: /Screen 1/ }));
        fireEvent.click(screen.getByRole("button", { name: "Start sharing" }));
        await expect(picked).resolves.toEqual({ id: "screen:0:0", sound: true });
    });

    it("lists windows on their own tab", () => {
        render(<DesktopSharePickerHost />, { wrapper: MessagesWrapper });
        act(() => {
            void pickDesktopShare(bridge, listed);
        });
        expect(screen.queryByRole("button", { name: /Notes/ })).toBeNull();
        fireEvent.click(screen.getByRole("tab", { name: /Windows/ }));
        expect(screen.getByRole("button", { name: /Notes/ })).toBeTruthy();
    });

    it("resolves null when it is closed", async () => {
        render(<DesktopSharePickerHost />, { wrapper: MessagesWrapper });
        let picked: Promise<unknown> = Promise.resolve();
        act(() => {
            picked = pickDesktopShare(bridge, listed);
        });
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        await expect(picked).resolves.toBeNull();
    });
});
