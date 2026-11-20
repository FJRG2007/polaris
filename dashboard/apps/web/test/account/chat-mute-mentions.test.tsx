// @vitest-environment jsdom
/**
 * Account > Notifications and "Mute mentions too" on Chat muted as a whole:
 * muting again for another length keeps the choice, and the page offers the
 * same switch the app menu does while Chat is muted.
 */

import { MessagesWrapper } from "../setup/i18n";
import type { NotificationHolds } from "@polaris/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { applyAppMuteMentions, applyHoldMute, appMutesMentions } from "@/lib/app-mutes";

vi.mock("../../src/app/(app)/account/notifications/actions", () => ({}));

const { EventGroups } = await import("../../src/app/(app)/account/notifications/event-groups");

const NOW = new Date("2026-11-20T12:00:00Z");
const CHAT = { kind: "app", id: "chat" } as const;
const mutedChat = (mentions?: boolean): NotificationHolds => ({
    mutes: { "app:chat": { until: null, ...(mentions ? { mentions } : {}) } },
    schedules: {}
});

afterEach(cleanup);

describe("muting Chat again from the page", () => {
    it("keeps mute mentions too for a new length", () => {
        const next = applyHoldMute(mutedChat(true), CHAT, "1h", NOW);
        expect(next.mutes["app:chat"]).toEqual({
            until: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
            mentions: true
        });
        expect(appMutesMentions(next, "chat", NOW)).toBe(true);
    });

    it("drops it once unmuted, so the next mute lets mentions through", () => {
        const unmuted = applyHoldMute(mutedChat(true), CHAT, null, NOW);
        const again = applyHoldMute(unmuted, CHAT, "off", NOW);
        expect(appMutesMentions(again, "chat", NOW)).toBe(false);
    });

    it("sets the switch only while Chat is muted", () => {
        const none: NotificationHolds = { mutes: {}, schedules: {} };
        expect(applyAppMuteMentions(none, "chat", true, NOW)).toBe(none);
        const on = applyAppMuteMentions(mutedChat(), "chat", true, NOW);
        expect(appMutesMentions(on, "chat", NOW)).toBe(true);
        expect(appMutesMentions(applyAppMuteMentions(on, "chat", false, NOW), "chat", NOW)).toBe(
            false
        );
    });
});

function show(holds: NotificationHolds) {
    const onMuteMentions = vi.fn();
    render(
        <MessagesWrapper>
            <EventGroups
                state={new Map()}
                destinations={[]}
                onChange={() => {}}
                appHolds={["chat"]}
                hold={{
                    holds,
                    timeZone: "UTC",
                    onMute: () => {},
                    onSchedule: () => {},
                    onMuteMentions
                }}
            />
        </MessagesWrapper>
    );
    const trigger = screen.getAllByRole("button", { name: /Chat/ }).at(-1)!;
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    return { onMuteMentions };
}

describe("the Chat card's menu", () => {
    it("offers mute mentions too while Chat is muted", async () => {
        const { onMuteMentions } = show(mutedChat());
        fireEvent.click(await screen.findByText("Mute mentions too"));
        expect(onMuteMentions).toHaveBeenCalledWith("chat", true);
    });

    it("turns it back off when it is on", async () => {
        const { onMuteMentions } = show(mutedChat(true));
        fireEvent.click(await screen.findByText("Mute mentions too"));
        expect(onMuteMentions).toHaveBeenCalledWith("chat", false);
    });

    it("does not offer it while Chat is not muted", async () => {
        show({ mutes: {}, schedules: {} });
        await screen.findByText("For 1 hour");
        expect(screen.queryByText("Mute mentions too")).toBeNull();
    });
});
