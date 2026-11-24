// @vitest-environment jsdom

/**
 * A game somebody is playing right now, on their profile's "Recent activity".
 *
 * The card of what they are doing already shows it, live, so the list leaves it
 * out while it is there - and shows it again the moment it stops, without the
 * profile being read again, which is how a game closed after the page opened
 * still reaches the list.
 */

import type * as core from "@polaris/core";
import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RecentActivityList } from "@/components/profile-sections";
import type { RecentActivityView } from "@/lib/presence-activity/recent";

const presence = vi.hoisted(() => ({ activity: [] as unknown[] }));

vi.mock("@/components/presence-store", () => ({
    usePresence: (id: string | null) =>
        id ? { status: "online", activity: presence.activity } : null
}));

const PERSON = "018f2b7a-0000-7000-8000-00000000000a";

const RECENT: RecentActivityView[] = [
    {
        source: "game",
        key: "played:rocketleague.exe",
        name: "Rocket League",
        details: "",
        imageUrl: null,
        gameId: null,
        endedAt: "2026-11-23T22:00:00.000Z"
    },
    {
        source: "minecraft",
        key: "server:mc1",
        name: "Minecraft",
        details: "Survival",
        imageUrl: null,
        gameId: "minecraft",
        endedAt: "2026-11-22T22:00:00.000Z"
    }
];

function live(name: string, source: core.ActivitySource = "game"): core.ActivityView {
    return {
        source,
        key: name,
        name,
        details: "",
        state: "",
        imageUrl: null,
        linkUrl: null,
        startedAt: "2026-11-24T10:00:00.000Z",
        endsAt: null
    };
}

function draw() {
    return render(
        <RecentActivityList personId={PERSON} heading="Recent activity" recent={RECENT} />,
        {
            wrapper: MessagesWrapper
        }
    );
}

afterEach(() => {
    cleanup();
    presence.activity = [];
});

describe("recent activity beside what they are doing now", () => {
    it("lists a game the desktop app saw, beside a server visit", () => {
        draw();
        expect(screen.getByText("Rocket League")).toBeTruthy();
        expect(screen.getByText("Minecraft")).toBeTruthy();
    });

    it("leaves out the game being played right now", () => {
        presence.activity = [live("Rocket League")];
        draw();
        expect(screen.queryByText("Rocket League")).toBeNull();
        expect(screen.getByText("Minecraft")).toBeTruthy();
    });

    it("never hides a server visit for a game running now", () => {
        presence.activity = [live("Minecraft", "minecraft")];
        draw();
        expect(screen.getByText("Minecraft")).toBeTruthy();
    });

    it("is not hidden by a song with the same name", () => {
        presence.activity = [live("Rocket League", "spotify")];
        draw();
        expect(screen.getByText("Rocket League")).toBeTruthy();
    });

    it("draws nothing when the only entry is the game being played", () => {
        presence.activity = [live("Rocket League"), live("Minecraft")];
        const { container } = render(
            <RecentActivityList
                personId={PERSON}
                heading="Recent activity"
                recent={RECENT.slice(0, 1)}
            />,
            { wrapper: MessagesWrapper }
        );
        expect(container.textContent).toBe("");
    });
});
