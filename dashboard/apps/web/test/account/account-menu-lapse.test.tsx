// @vitest-environment jsdom

/**
 * The exact bug that was reported: Invisible, set "For 8 hours", left open
 * overnight. The server tidied the row the moment the window passed and
 * everybody else read that off `/api/presence` - but the tab that set it kept
 * showing "Invisible, ticked, until 07:00" for as long as it stayed open,
 * because the props it was seeded from are resolved once, in a layout that
 * does not re-render on a soft navigation.
 *
 * This mounts the actual menu once - no remount, no reload, exactly the tab
 * that was left open - and lets its own window lapse under it. What is
 * asserted is the one thing that matters: the person relying on the setting is
 * told, on their own screen, the moment it stops being true.
 *
 * And the second report, which is what the answer to the first used to cost:
 * every write ended in `router.refresh()`, so moving a tick in this dropdown
 * re-rendered the whole chrome - navigation, unread counts, notifications and
 * whatever screen was open - which on a heavy page is a visible stutter. The
 * server still gets the last word; it just says it in the answer to the write
 * rather than by re-rendering the page.
 */

import userEvent from "@testing-library/user-event";
import { AccountMenu } from "@/components/account-menu";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";

const routerRefresh = vi.fn();
const presenceRefresh = vi.fn();
const asked = vi.fn();
const chosen = vi.fn();

/** What the server says is in force, which the tests below move about. */
let held = {
    choice: "auto" as string,
    until: null as string | null,
    scheduled: false,
    nextChangeAt: null as string | null
};

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: () => undefined, refresh: routerRefresh })
}));
vi.mock("@/lib/auth-client", () => ({ signOut: async () => undefined }));
vi.mock("@/components/presence-store", () => ({
    usePresenceRefresh: () => presenceRefresh,
    usePresence: () => null
}));
vi.mock("@/app/(app)/account/sessions/actions", () => ({
    noteSignOutAction: async () => undefined
}));
vi.mock("@/app/(app)/account/preferences/actions", () => ({
    presenceNowAction: async () => {
        asked();
        return { held, status: { text: "", until: null } };
    },
    setPresenceAction: async (choice: string) => {
        chosen(choice);
        return { held };
    },
    setStatusAction: async () => ({ status: { text: "", until: null } })
}));

// The exact report: set the night before, "For 8 hours".
const SET_AT = new Date("2026-08-20T00:00:00.000Z");
const WINDOW_END = new Date("2026-08-20T08:00:00.000Z");

beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(SET_AT);
    routerRefresh.mockClear();
    presenceRefresh.mockClear();
    asked.mockClear();
    chosen.mockClear();
    held = { choice: "auto", until: null, scheduled: false, nextChangeAt: null };
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

function rowFor(name: string): HTMLElement {
    return screen.getByText(name).closest("[role=menuitem]") as HTMLElement;
}

describe("the picker left open across the window it set", () => {
    it("stops showing Invisible as chosen the moment its own window has passed - with no reload", async () => {
        const user = userEvent.setup({ delay: null, advanceTimers: vi.advanceTimersByTime });
        render(
            <AccountMenu
                id="ada"
                name="Ada"
                email="ada@example.com"
                presence="invisible"
                presenceUntil={WINDOW_END.toISOString()}
                presenceScheduled={false}
                presenceNextChange={WINDOW_END.toISOString()}
                status=""
                statusUntil={null}
            />
        );

        await user.click(screen.getByRole("button", { name: "Your account" }));
        await screen.findByRole("menu");
        expect(within(rowFor("Invisible")).getByText(/until/)).toBeDefined();
        // The window has not passed yet: nobody has been asked anything.
        expect(presenceRefresh).not.toHaveBeenCalled();

        // The tab stays open, exactly as reported, across the moment the window
        // it set ends - no reload, no re-render from a layout above it.
        await act(async () => {
            vi.setSystemTime(new Date(WINDOW_END.getTime() + 31_000));
            await vi.advanceTimersByTimeAsync(31_000);
        });

        // The other half of the fix: the server is told what took over, which is
        // what keeps every other screen watching this account in sync with this
        // one rather than only fixing what this tab shows.
        expect(presenceRefresh).toHaveBeenCalled();
        // Asked, rather than the whole page re-rendered to find out.
        expect(asked).toHaveBeenCalled();
        expect(routerRefresh).not.toHaveBeenCalled();

        expect(within(rowFor("Invisible")).queryByText(/until/)).toBeNull();
        expect(rowFor("Online").querySelector("svg.text-primary")).not.toBeNull();
    });
});

describe("choosing a status", () => {
    async function pickOnline() {
        const user = userEvent.setup({ delay: null, advanceTimers: vi.advanceTimersByTime });
        render(
            <AccountMenu
                id="ada"
                name="Ada"
                email="ada@example.com"
                presence="busy"
                presenceUntil={null}
                presenceScheduled={false}
                presenceNextChange={null}
                status=""
                statusUntil={null}
            />
        );
        await user.click(screen.getByRole("button", { name: "Your account" }));
        await screen.findByRole("menu");
        await act(async () => void rowFor("Online").click());
        // Past the double-press window before the face is pressed again: two
        // presses inside it are one gesture, and that gesture opens the account
        // rather than the menu.
        await act(async () => {
            vi.setSystemTime(new Date(Date.now() + 1_000));
            await vi.advanceTimersByTimeAsync(1_000);
        });
        // Reopened, because choosing closes the menu.
        await user.click(screen.getByRole("button", { name: "Your account" }));
        await screen.findByRole("menu");
    }

    it("re-renders nothing above it", async () => {
        await pickOnline();
        expect(chosen).toHaveBeenCalledWith("auto");
        // The dots elsewhere on screen are asked about; the page is not thrown
        // away and built again to move a tick.
        expect(presenceRefresh).toHaveBeenCalled();
        expect(routerRefresh).not.toHaveBeenCalled();
        expect(rowFor("Online").querySelector("svg.text-primary")).not.toBeNull();
    });

    it("takes the server's answer over its own guess", async () => {
        // A standing-hours window is open, so "Online" is not what the account
        // ends up as - the window keeps it until it closes. The menu has to say
        // so rather than tick what was pressed.
        held = {
            choice: "invisible",
            until: WINDOW_END.toISOString(),
            scheduled: true,
            nextChangeAt: WINDOW_END.toISOString()
        };
        await pickOnline();
        expect(rowFor("Invisible").querySelector("svg.text-primary")).not.toBeNull();
        expect(within(rowFor("Invisible")).getByText(/until/)).toBeDefined();
        expect(routerRefresh).not.toHaveBeenCalled();
    });
});
