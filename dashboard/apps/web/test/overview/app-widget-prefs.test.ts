/**
 * Where the apps' cards are kept, and that nothing else writes them away.
 *
 * They live in the account's Overview layout beside its own cards, saved on an
 * action of their own. Arranging the Overview saves the layout without them -
 * every save the grid makes, and every tab opened before apps could add cards -
 * and that must keep what is stored rather than empty it.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

let stored: core.OverviewPreferences = core.EMPTY_OVERVIEW_PREFERENCES;
const save = vi.fn(async (_user: string, next: core.OverviewPreferences) => {
    stored = next;
});

vi.mock("@/lib/session", () => ({ requireUser: async () => ({ id: "u1" }) }));
vi.mock("@/lib/overview/prefs-service", () => ({
    getOverviewPreferences: async () => stored,
    saveOverviewPreferences: save
}));
vi.mock("@/lib/overview/app-widgets", () => ({}));

const { saveOverviewPreferencesAction } = await import("@/app/(app)/home/actions");
const { saveAppWidgetsAction } = await import("@/app/(app)/home/app-widget-actions");

const CARD = {
    id: "a1b2c3d4e5f60718",
    app: "home",
    kind: "device-controls",
    size: "md" as const,
    targets: ["dev-1", "dev-2"]
};

beforeEach(() => {
    stored = { ...core.EMPTY_OVERVIEW_PREFERENCES, appWidgets: [CARD] };
    save.mockClear();
});

describe("the stored layout", () => {
    it("reads a layout saved before apps had cards as having none", () => {
        const old = core.parseOverviewPreferences(JSON.stringify({ widgets: [], shortcuts: [] }));
        expect(old.appWidgets).toEqual([]);
    });

    it("keeps the apps' cards when the Overview's own cards are saved without them", async () => {
        await saveOverviewPreferencesAction({ widgets: [], shortcuts: [], greeting: false });
        expect(stored.appWidgets).toEqual([CARD]);
        expect(stored.greeting).toBe(false);
    });

    it("saves the apps' cards on their own, leaving the rest", async () => {
        stored = { ...stored, greeting: false };
        const moved = { ...CARD, size: "lg" as const, targets: ["dev-2"] };
        expect(await saveAppWidgetsAction([moved])).toEqual({});
        expect(stored.appWidgets).toEqual([moved]);
        expect(stored.greeting).toBe(false);
    });

    it("refuses a card that is not in the stored shape, and two with one id", async () => {
        for (const bad of [
            [{ ...CARD, app: "../etc" }],
            [{ ...CARD, targets: Array.from({ length: core.MAX_APP_WIDGET_TARGETS + 1 }, (_, at) => `d${at}`) }],
            Array.from({ length: core.MAX_APP_WIDGETS + 1 }, (_, at) => ({ ...CARD, id: `card${String(at).padStart(8, "0")}` })),
            [CARD, CARD]
        ]) {
            expect((await saveAppWidgetsAction(bad)).error).toBeTruthy();
        }
        expect(save).not.toHaveBeenCalled();
    });
});
