// @vitest-environment jsdom

/**
 * Settings > Privacy > Activity sharing, the page Discord splits into "Activity
 * Privacy" and "Registered Games".
 *
 * What is protected: the page is the two sections, in that order; a source or a
 * game with an official mark draws that mark and every other game the generic
 * pad, never a lookalike; the game being played right now sits above the list;
 * every remembered game says when it was last played and can be hidden; a game
 * somebody added can be taken off again; and the page can be reached from the
 * account menu, the left rail and the search, which are the three ways anybody
 * looks for it.
 */

import * as core from "@polaris/core";
import userEvent from "@testing-library/user-event";
import { AccountMenu } from "@/components/account-menu";
import { searchItems } from "@polaris/core/search-text";
import { APP_SECTIONS, isSectionActive } from "@/lib/apps";
import { MessagesWrapper, withMessages } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { COMMAND_ENTRY_FIELDS, navigationEntries } from "@/lib/search/entries";
import { ActivitySharingCard } from "@/app/(app)/account/privacy/activity-sharing-card";

const saved = vi.fn();
let playing: core.ActivityView[] = [];

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: () => undefined, refresh: () => undefined })
}));
vi.mock("@/app/(app)/account/privacy/actions", () => ({
    saveActivitySettingsAction: async (next: core.ActivitySettings) => {
        saved(next);
        return {};
    }
}));
vi.mock("@/components/desktop-app", () => ({ useDesktopBridge: () => null }));
vi.mock("@/components/presence-store", () => ({
    usePresenceRefresh: () => () => undefined,
    usePresence: () => ({ activity: playing })
}));
vi.mock("@/lib/auth-client", () => ({ signOut: async () => undefined }));
vi.mock("@/components/device-accounts", () => ({ AccountSwitcherDialog: () => null }));
vi.mock("@/app/(app)/account/preferences/actions", () => ({
    presenceNowAction: async () => ({
        held: { choice: "auto", until: null, scheduled: false, nextChangeAt: null },
        status: { text: "", until: null }
    }),
    setPresenceAction: async () => ({
        held: { choice: "auto", until: null, scheduled: false, nextChangeAt: null }
    }),
    setStatusAction: async () => ({ status: { text: "", until: null } })
}));

const SEEN: core.SeenGame[] = [
    { key: "javaw.exe", name: "Minecraft", seenAt: "2026-10-17T20:00:00.000Z" },
    { key: "hollow_knight.exe", name: "Hollow Knight", seenAt: "2026-10-10T20:00:00.000Z" }
];

function draw(settings: Partial<core.ActivitySettings> = {}) {
    return render(
        <ActivitySharingCard
            settings={{ ...core.DEFAULT_ACTIVITY_SETTINGS, ...settings }}
            seenGames={SEEN}
            spotify="linked"
            userId="ada"
        />,
        { wrapper: MessagesWrapper }
    );
}

/** The list item a game's name is written in. */
function rowOf(name: string): HTMLElement {
    return screen.getByText(name, { selector: "li span" }).closest("li") as HTMLElement;
}

beforeEach(() => {
    saved.mockClear();
    playing = [];
});
afterEach(cleanup);

describe("the two sections", () => {
    it("puts Activity status before Registered games, and points to who sees it", () => {
        draw();
        const headings = screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent);
        expect(headings).toEqual(["Activity status", "Registered games"]);
        expect(screen.getByRole("link", { name: "Privacy" }).getAttribute("href")).toBe("/account/privacy");
        expect(screen.getByRole("switch", { name: "Share my activity" })).toBeDefined();
        expect(screen.getByRole("switch", { name: "Spotify" })).toBeDefined();
    });

    it("draws an official mark where one exists and the generic pad everywhere else", () => {
        const { container } = draw();
        // The Minecraft source row and the Minecraft game row both carry the
        // catalog's own picture.
        const minecraft = [...container.querySelectorAll("img")].filter(
            (img) => img.getAttribute("src") === "/logos/minecraft.webp"
        );
        expect(minecraft.length).toBeGreaterThanOrEqual(2);
        expect(rowOf("Minecraft").querySelector("img")?.getAttribute("src")).toBe("/logos/minecraft.webp");
        // A game Polaris has no mark for is never given a guessed one.
        expect(rowOf("Hollow Knight").querySelector("img")).toBeNull();
        expect(rowOf("Hollow Knight").querySelector("svg")).not.toBeNull();
    });
});

describe("Registered games", () => {
    it("says no game is detected, and where to add one", () => {
        draw();
        expect(screen.getByText("No game detected")).toBeDefined();
        expect(screen.getByText("Not seeing your game? Add it below.")).toBeDefined();
    });

    it("shows the game being played right now above the list, with its mark", () => {
        playing = [
            {
                source: "game",
                name: "FiveM",
                detail: null,
                imageUrl: null,
                linkUrl: null,
                startedAt: "2026-10-18T10:00:00.000Z",
                endsAt: null
            } as unknown as core.ActivityView
        ];
        const { container } = draw();
        expect(screen.getByText("Now playing")).toBeDefined();
        expect(screen.getByText("FiveM")).toBeDefined();
        expect(container.querySelector('img[src="/logos/fivem.svg"]')).not.toBeNull();
    });

    it("says when each game was last played, and hides one with its switch", async () => {
        const user = userEvent.setup();
        draw();
        expect(within(rowOf("Hollow Knight")).getByText(/Last played/)).toBeDefined();
        await user.click(screen.getByRole("switch", { name: "Show Hollow Knight" }));
        expect(within(rowOf("Hollow Knight")).getByText("Never shown")).toBeDefined();
        await vi.waitFor(() => expect(saved).toHaveBeenCalled());
        expect(saved.mock.calls[0]?.[0].hiddenGames).toEqual(["hollow_knight.exe"]);
    });

    it("lists a game somebody added with the others, and takes it off again", async () => {
        const user = userEvent.setup();
        draw({ customGames: [{ executable: "mygame.exe", name: "My Game" }] });
        expect(within(rowOf("My Game")).getByText("Added by you")).toBeDefined();
        await user.click(screen.getByRole("button", { name: "Remove My Game" }));
        expect(screen.queryByText("My Game", { selector: "li span" })).toBeNull();
        await vi.waitFor(() => expect(saved).toHaveBeenCalled());
        expect(saved.mock.calls[0]?.[0].customGames).toEqual([]);
    });

    it("greys every game out while sharing is off", () => {
        draw({ share: false });
        expect(screen.queryByText("No game detected")).toBeNull();
        expect(screen.getByRole("switch", { name: "Show Hollow Knight" }).hasAttribute("disabled")).toBe(true);
    });

    it("draws in Spanish too", () => {
        render(
            withMessages(
                <ActivitySharingCard
                    settings={core.DEFAULT_ACTIVITY_SETTINGS}
                    seenGames={SEEN}
                    spotify="linked"
                    userId="ada"
                />,
                "es-ES"
            )
        );
        const headings = screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent);
        expect(headings).toEqual(["Estado de actividad", "Juegos registrados"]);
    });
});

describe("reaching the page", () => {
    const HREF = "/account/privacy/activity";

    it("is in the account menu", async () => {
        const user = userEvent.setup();
        render(
            <AccountMenu
                id="ada"
                name="Ada"
                email="ada@example.com"
                presence="online"
                presenceUntil={null}
                presenceScheduled={false}
                presenceNextChange={null}
                status=""
                statusUntil={null}
            />,
            { wrapper: MessagesWrapper }
        );
        await user.click(screen.getByRole("button", { name: "Your account" }));
        const item = await screen.findByRole("menuitem", { name: "Activity sharing" });
        expect(item.getAttribute("href")).toBe(HREF);
    });

    it("is a page of its own in the Privacy group of the rail, lit on its own", () => {
        const sections = APP_SECTIONS.account ?? [];
        const entry = sections.find((section) => section.href === HREF);
        expect(entry?.label).toBe("Activity sharing");
        expect(entry?.group).toBe("Privacy");
        expect(isSectionActive(HREF, HREF, sections)).toBe(true);
        // The privacy page itself does not stay lit underneath it.
        expect(isSectionActive(HREF, "/account/privacy", sections)).toBe(false);
    });

    it("is found by search, by its name and by what is on it", () => {
        const pool = navigationEntries(false, []);
        for (const query of ["activity sharing", "registered games", "spotify", "activity privacy"]) {
            const found = searchItems(pool, query, COMMAND_ENTRY_FIELDS).map((entry) => entry.href);
            expect(found, query).toContain(HREF);
        }
    });
});
