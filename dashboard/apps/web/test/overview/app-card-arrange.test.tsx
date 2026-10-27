// @vitest-environment jsdom

/**
 * An app's card on the Overview is arranged like every other card.
 *
 * App cards were drawn after the Overview's own, outside its order, with no
 * handle and nowhere to drop: "Quick controls" could not be dragged anywhere and
 * nothing could be dropped onto it. They now share one order with the
 * Overview's own cards, both ways, and that order is what is saved.
 */

import { MessagesWrapper } from "../setup/i18n";
import type { OverviewPreferences } from "@polaris/core";
import type { AppWidgetKind } from "@/lib/overview/app-widgets";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

const saveLayout = vi.hoisted(() => vi.fn(async (_input: unknown) => ({})));
const saveCards = vi.hoisted(() => vi.fn(async (_input: unknown) => ({})));

vi.mock("@/app/(app)/home/actions", () => ({ saveOverviewPreferencesAction: saveLayout }));
vi.mock("@/app/(app)/home/app-widget-actions", () => ({
    actOnAppWidgetAction: vi.fn(),
    appWidgetTargetsAction: vi.fn(async () => ({ targets: [] })),
    saveAppWidgetsAction: saveCards
}));
vi.mock("@/app/(app)/home/home-polls", () => ({ appWidgets: vi.fn(async () => ({ cards: {} })) }));
vi.mock("@/app/(app)/home/widgets/personal", () => ({
    AppsWidget: () => <p>apps body</p>,
    NotificationsWidget: () => null,
    RecentWidget: () => null,
    ShortcutsWidget: () => <p>shortcuts body</p>
}));
vi.mock("@/app/(app)/home/widgets/infrastructure", () => ({
    AlarmsWidget: () => null,
    GamesWidget: () => null,
    ServicesWidget: () => null,
    StorageWidget: () => null,
    TasksWidget: () => null,
    UsageWidget: () => null
}));
vi.mock("@/app/(app)/home/widgets/account", () => ({
    ActivityWidget: () => null,
    SessionsWidget: () => null
}));
vi.mock("@/app/(app)/home/widgets/calendar", () => ({ CalendarWidget: () => null }));
vi.mock("@/app/(app)/home/widgets/dns-blocker", () => ({ DnsBlockerWidget: () => null }));
vi.mock("@/app/(app)/home/shortcut-picker", () => ({ ShortcutPicker: () => null }));

const { OverviewGrid } = await import("@/app/(app)/home/overview-grid");

const KIND: AppWidgetKind = {
    app: "places",
    kind: "controls",
    label: "Quick controls",
    hint: "Switch things from here",
    defaultSize: "md"
};

const PREFERENCES: OverviewPreferences = {
    widgets: [
        { id: "shortcuts", size: "lg", hidden: false },
        { id: "apps", size: "md", hidden: false }
    ],
    appWidgets: [
        {
            id: "card0001",
            app: "places",
            kind: "controls",
            size: "md",
            targets: ["lamp"],
            hidden: false
        }
    ],
    shortcuts: [],
    greeting: true,
    arranged: true
};

function draw(preferences: OverviewPreferences = PREFERENCES) {
    return render(
        <MessagesWrapper>
            <OverviewGrid
                name="Fixture User"
                isAdmin={false}
                preferences={preferences}
                available={["shortcuts", "apps"]}
                layout={preferences.widgets}
                apps={[{ id: "drive", label: "Drive", description: "", href: "/drive" }]}
                gate={{ held: [], installed: [] }}
                appKinds={[KIND]}
            />
        </MessagesWrapper>
    );
}

/** The cards on the grid, in the order they are drawn. */
function drawn(container: HTMLElement): string[] {
    return [...container.querySelectorAll(".overview-grid > [data-widget]")].map((cell) =>
        cell.getAttribute("data-widget")!
    );
}

/** Drag one card's handle onto another card. */
function drag(container: HTMLElement, from: string, onto: string): void {
    const handle = container.querySelector(`[data-widget="${from}"] [draggable]`)!;
    const target = container.querySelector(`[data-widget="${onto}"]`)!;
    const dataTransfer = {
        setData: vi.fn(),
        setDragImage: vi.fn(),
        effectAllowed: "",
        dropEffect: ""
    };
    fireEvent.dragStart(handle, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
    fireEvent.dragEnd(handle, { dataTransfer });
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("{}", { status: 200 }))
    );
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    saveLayout.mockClear();
    saveCards.mockClear();
});

describe("an app card on the Overview", () => {
    it("is drawn after the Overview's own cards in a layout saved before the shared order", () => {
        const { container } = draw();
        expect(drawn(container)).toEqual(["shortcuts", "apps", "app:card0001"]);
        // The same handle every card has.
        expect(container.querySelector('[data-widget="app:card0001"] [draggable]')).toBeTruthy();
    });

    it("can be dropped onto one of the Overview's own cards, and that is saved", async () => {
        const { container } = draw();
        drag(container, "app:card0001", "shortcuts");
        expect(drawn(container)).toEqual(["app:card0001", "shortcuts", "apps"]);
        await act(async () => vi.runAllTimers());
        expect(saveLayout).toHaveBeenCalledTimes(1);
        expect(saveLayout.mock.calls[0]![0]).toMatchObject({
            order: ["app:card0001", "shortcuts", "apps"],
            widgets: [{ id: "shortcuts" }, { id: "apps" }],
            arranged: true
        });
    });

    it("takes one of the Overview's own cards dropped onto it", () => {
        const { container } = draw();
        drag(container, "shortcuts", "app:card0001");
        expect(drawn(container)).toEqual(["apps", "app:card0001", "shortcuts"]);
    });

    it("comes back where it was put", () => {
        const { container } = draw({
            ...PREFERENCES,
            order: ["apps", "app:card0001", "shortcuts"]
        });
        expect(drawn(container)).toEqual(["apps", "app:card0001", "shortcuts"]);
    });

    it("is shown again at its kind's size after Reset", async () => {
        const { getAllByRole, getByRole } = draw({
            ...PREFERENCES,
            appWidgets: [{ ...PREFERENCES.appWidgets[0]!, size: "xl", hidden: true }]
        });
        fireEvent.click(getAllByRole("button", { name: "Customize" })[0]!);
        fireEvent.click(getByRole("button", { name: "Reset" }));
        await act(async () => vi.runAllTimers());
        expect(saveCards).toHaveBeenCalledTimes(1);
        expect(saveCards.mock.calls[0]![0]).toEqual([
            { ...PREFERENCES.appWidgets[0]!, size: "md", hidden: false }
        ]);
    });
});
