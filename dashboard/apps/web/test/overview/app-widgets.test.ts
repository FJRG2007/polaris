/**
 * The Overview's contribution point for installable apps.
 *
 * Any installed app can offer cards for the Overview by kind; the dashboard
 * lists them, reads every card on the screen at once, and passes a press to the
 * app that owns the card. These pin the generic half, with a fixture app rather
 * than Places: a card whose app went away says so, one that failed to read says
 * so on that card alone, and a press is checked against what the reader's own
 * stored card watches before any app is asked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const read = vi.fn();
const act = vi.fn(async () => ({}));
const describeCard = vi.fn(async () => ({ label: "Fixture card", hint: "What the fixture shows" }));
let installed = true;

const FIXTURE = {
    id: "fixture-app",
    overviewWidgets: () => [
        {
            kind: "readings",
            defaultSize: "md" as const,
            describe: describeCard,
            targets: async () => [{ id: "t1", label: "Thing one" }],
            read,
            act
        }
    ]
};

vi.mock("@/lib/app-extensions/installed", () => ({ installedExtensions: () => [FIXTURE] }));
vi.mock("@/lib/apps/install-presence", () => ({ isAppInstalled: async () => installed }));

const widgets = await import("@/lib/overview/app-widgets");

const card = (targets: string[], kind = "readings") => ({
    id: "card0001",
    app: "fixture-app",
    kind,
    size: "md" as const,
    targets
});

beforeEach(() => {
    vi.clearAllMocks();
    installed = true;
    read.mockResolvedValue({ items: [] });
});

describe("the kinds on offer", () => {
    it("are every installed app's, named by the app", async () => {
        expect(await widgets.availableAppWidgetKinds()).toEqual([
            {
                app: "fixture-app",
                kind: "readings",
                label: "Fixture card",
                hint: "What the fixture shows",
                defaultSize: "md"
            }
        ]);
    });

    it("are none from an app that is not installed", async () => {
        installed = false;
        expect(await widgets.availableAppWidgetKinds()).toEqual([]);
        expect(await widgets.appWidgetTargets("fixture-app", "readings")).toEqual([]);
    });

    it("leave out an app that could not name its card, and keep the rest", async () => {
        describeCard.mockRejectedValueOnce(new Error("boom"));
        const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        expect(await widgets.availableAppWidgetKinds()).toEqual([]);
        spy.mockRestore();
    });
});

describe("reading the cards on one Overview", () => {
    it("asks each card's app with what that card watches", async () => {
        const view = { items: [{ id: "t1", title: "Thing one", readings: [], controls: [] }] };
        read.mockResolvedValue(view);
        expect(await widgets.readAppWidgets([card(["t1"])])).toEqual({
            card0001: { ok: true, view }
        });
        expect(read).toHaveBeenCalledWith(["t1"]);
    });

    it("says a card is gone when its app no longer offers it, and failed when it threw", async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        read.mockRejectedValue(new Error("down"));
        expect(
            await widgets.readAppWidgets([card(["t1"]), { ...card(["t1"], "retired"), id: "card0002" }])
        ).toEqual({
            card0001: { ok: false, reason: "failed" },
            card0002: { ok: false, reason: "gone" }
        });
        spy.mockRestore();
    });
});

describe("a press", () => {
    it("reaches the app with the stored card's targets", async () => {
        const input = { item: "t1", control: "power", value: true };
        expect(await widgets.actOnAppWidget(card(["t1", "t2"]), input)).toEqual({});
        expect(act).toHaveBeenCalledWith(["t1", "t2"], input);
    });

    it("is refused before the app is asked when it names something the card does not watch", async () => {
        expect(
            await widgets.actOnAppWidget(card(["t1"]), { item: "t9", control: "power", value: true })
        ).toEqual({ error: "unknown" });
        expect(act).not.toHaveBeenCalled();
    });

    it("carries the app's own refusal back", async () => {
        act.mockResolvedValueOnce({ error: "You cannot operate that from here" } as never);
        expect(
            await widgets.actOnAppWidget(card(["t1"]), { item: "t1", control: "power", value: true })
        ).toEqual({ error: "You cannot operate that from here" });
    });

    it("is validated in shape before anything", () => {
        expect(widgets.appWidgetInputSchema.safeParse({ item: "t1", control: "x", value: "on" }).success).toBe(
            false
        );
        expect(
            widgets.appWidgetInputSchema.safeParse({ item: "t1", control: "x", value: Number.NaN }).success
        ).toBe(false);
    });
});
