// @vitest-environment jsdom

/**
 * The time of year on the frame, and the switches that govern it.
 *
 * What somebody depends on: the decoration and the season's sound pack appear on
 * the reader's own date and not otherwise, with nothing to set up; both are gone
 * for everybody when the operator turns them off; one person can turn off the
 * pack in force, and only that one; and a switch that could not be saved goes
 * back to what is really kept.
 */

import { withMessages } from "../../setup/i18n";
import { soundSeason } from "@/lib/sound-season";
import { SEASONAL_DEFAULTS } from "@polaris/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const save = vi.fn();
vi.mock("@/app/(app)/account/preferences/seasonal-actions", () => ({
    saveSeasonalAction: (input: unknown) => save(input)
}));

const { SeasonalBadge, SeasonalFrame } = await import("@/components/seasonal/seasonal-frame");
const { SeasonalCard } = await import("@/components/seasonal/seasonal-card");

function frame(props: { allowed: boolean; mutedPack: string | null }) {
    return render(
        withMessages(
            <SeasonalFrame {...props}>
                <a href="/home" aria-label="Polaris overview">
                    <SeasonalBadge />
                </a>
            </SeasonalFrame>
        )
    );
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 25, 12));
    save.mockReset();
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe("the frame", () => {
    it("decorates and plays the season's pack on the reader's date, with nothing to set up", () => {
        frame({ allowed: true, mutedPack: null });
        expect(document.documentElement.dataset.season).toBe("halloween");
        expect(screen.getByTitle("Halloween")).toBeDefined();
        expect(document.querySelectorAll(".season-drift .season-piece").length).toBeGreaterThan(0);
        expect(soundSeason()).toBe("halloween");
    });

    it("keeps the ordinary sounds for somebody who turned this pack off, and still decorates", () => {
        frame({ allowed: true, mutedPack: "halloween-2026" });
        expect(soundSeason()).toBeNull();
        expect(document.documentElement.dataset.season).toBe("halloween");
    });

    it("plays the next season's pack to somebody who turned off the last one", () => {
        frame({ allowed: true, mutedPack: "halloween-2025" });
        expect(soundSeason()).toBe("halloween");
    });

    it("is nothing at all when the operator turned seasons off", () => {
        frame({ allowed: false, mutedPack: null });
        expect(document.documentElement.dataset.season).toBeUndefined();
        expect(soundSeason()).toBeNull();
        expect(screen.queryByTitle("Halloween")).toBeNull();
    });

    it("is nothing on an ordinary day", () => {
        vi.setSystemTime(new Date(2026, 5, 15, 12));
        frame({ allowed: true, mutedPack: null });
        expect(document.documentElement.dataset.season).toBeUndefined();
        expect(soundSeason()).toBeNull();
    });

    it("takes the decoration and the sounds away when it goes", () => {
        const view = frame({ allowed: true, mutedPack: null });
        view.unmount();
        expect(document.documentElement.dataset.season).toBeUndefined();
        expect(soundSeason()).toBeNull();
    });
});

describe("the preferences card", () => {
    it("offers only the pack in force, by name, on until the season ends", () => {
        render(withMessages(<SeasonalCard allowed initial={SEASONAL_DEFAULTS} />));
        const pack = screen.getByRole("switch", { name: "Halloween sound pack" });
        expect(pack.getAttribute("aria-checked")).toBe("true");
        expect(screen.getByText(/until/)).toBeDefined();
        expect(screen.queryByRole("switch", { name: "Decorations" })).toBeNull();
    });

    it("is not there on an ordinary day, with no pack to turn off", () => {
        vi.setSystemTime(new Date(2026, 5, 15, 12));
        const view = render(withMessages(<SeasonalCard allowed initial={SEASONAL_DEFAULTS} />));
        expect(view.container.textContent).toBe("");
    });

    it("turns off this run of the pack, and puts the switch back when the save is refused", async () => {
        save.mockResolvedValue({ error: "Your choice could not be saved. Try again in a moment." });
        render(withMessages(<SeasonalCard allowed initial={SEASONAL_DEFAULTS} />));
        const pack = screen.getByRole("switch", { name: "Halloween sound pack" });
        act(() => fireEvent.click(pack));
        expect(save).toHaveBeenCalledWith({ mutedPack: "halloween-2026" });
        await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("could not be saved"));
        expect(pack.getAttribute("aria-checked")).toBe("true");
    });

    it("turns a pack back on", () => {
        save.mockResolvedValue({ choice: SEASONAL_DEFAULTS });
        render(withMessages(<SeasonalCard allowed initial={{ mutedPack: "halloween-2026" }} />));
        const pack = screen.getByRole("switch", { name: "Halloween sound pack" });
        expect(pack.getAttribute("aria-checked")).toBe("false");
        act(() => fireEvent.click(pack));
        expect(save).toHaveBeenCalledWith({ mutedPack: null });
    });

    it("is not there while the operator has seasons off", () => {
        const view = render(withMessages(<SeasonalCard allowed={false} initial={SEASONAL_DEFAULTS} />));
        expect(view.container.textContent).toBe("");
    });
});
