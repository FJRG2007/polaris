// @vitest-environment jsdom

/**
 * The app's right click offers muting its notifications, as a submenu of the
 * same spans Chat's conversation mute has, and says until when once muted.
 * An app with nothing to mute is not offered it.
 */

import { MessagesWrapper } from "../setup/i18n";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { NotificationHolds } from "@polaris/core";
import { AppActionsMenu } from "@/components/app-actions-menu";
import { AppMutesContext } from "@/components/app-mutes-context";

const mute = vi.fn();

function draw(appId: string, holds: NotificationHolds = { mutes: {}, schedules: {} }) {
    const Wrapper = ({ children }: { children: ReactNode }) => (
        <MessagesWrapper>
            <AppMutesContext.Provider value={{ holds, mute }}>{children}</AppMutesContext.Provider>
        </MessagesWrapper>
    );
    render(
        <AppActionsMenu appId={appId}>
            <button type="button">tile</button>
        </AppActionsMenu>,
        { wrapper: Wrapper }
    );
    fireEvent.contextMenu(screen.getByText("tile"));
}

afterEach(() => {
    cleanup();
    mute.mockClear();
});

describe("muting from the app menu", () => {
    it("offers the mute as a submenu with every span", async () => {
        draw("chat");
        const trigger = await screen.findByText("Mute notifications");
        fireEvent.keyDown(trigger, { key: "ArrowRight" });
        for (const label of [
            "For 1 hour",
            "For 8 hours",
            "For 24 hours",
            "For 1 week",
            "Until I turn it back on"
        ]) {
            expect(await screen.findByText(label)).toBeTruthy();
        }
        fireEvent.click(screen.getByText("For 8 hours"));
        expect(mute).toHaveBeenCalledWith("chat", "8h");
    });

    it("offers the unmute, with its end, once muted", async () => {
        const until = new Date(Date.now() + 60 * 60_000).toISOString();
        draw("mail", { mutes: { "group:mail": { until } }, schedules: {} });
        const item = await screen.findByText(/^Unmute \(until .+\)$/);
        expect(screen.queryByText("Mute notifications")).toBeNull();
        fireEvent.click(item);
        expect(mute).toHaveBeenCalledWith("mail", null);
    });

    it("says unmute alone for a mute with no end", async () => {
        draw("chat", { mutes: { "app:chat": { until: null } }, schedules: {} });
        expect(await screen.findByText("Unmute notifications")).toBeTruthy();
    });

    it("is not offered for an app with no notifications", async () => {
        draw("vault");
        await screen.findByText("Open on entry");
        expect(screen.queryByText("Mute notifications")).toBeNull();
    });
});
