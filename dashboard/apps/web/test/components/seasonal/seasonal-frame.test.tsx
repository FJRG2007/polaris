// @vitest-environment jsdom

/**
 * The time of year on the frame, and the switches that govern it.
 *
 * What somebody depends on: the decoration appears on the reader's own date and
 * not otherwise; it is gone for everybody when the operator turns it off, and
 * for one person when they do; the season's sounds play only for somebody who
 * asked; and a switch that could not be saved goes back to what is really kept.
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

function frame(props: { allowed: boolean; theme: boolean; sounds: boolean }) {
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
    it("decorates on the reader's date, with the season named on the mark", () => {
        frame({ allowed: true, theme: true, sounds: false });
        expect(document.documentElement.dataset.season).toBe("halloween");
        expect(screen.getByTitle("Halloween")).toBeDefined();
        expect(document.querySelectorAll(".season-drift .season-piece").length).toBeGreaterThan(0);
        // The ordinary sounds, until somebody asks for the season's.
        expect(soundSeason()).toBeNull();
    });

    it("plays the season's sounds only for somebody who asked", () => {
        frame({ allowed: true, theme: false, sounds: true });
        expect(soundSeason()).toBe("halloween");
        expect(document.documentElement.dataset.season).toBeUndefined();
        expect(document.querySelector(".season-drift")).toBeNull();
    });

    it("is nothing at all when the operator turned seasons off", () => {
        frame({ allowed: false, theme: true, sounds: true });
        expect(document.documentElement.dataset.season).toBeUndefined();
        expect(soundSeason()).toBeNull();
        expect(screen.queryByTitle("Halloween")).toBeNull();
    });

    it("is nothing on an ordinary day", () => {
        vi.setSystemTime(new Date(2026, 5, 15, 12));
        frame({ allowed: true, theme: true, sounds: true });
        expect(document.documentElement.dataset.season).toBeUndefined();
        expect(soundSeason()).toBeNull();
    });

    it("takes the decoration and the sounds away when it goes", () => {
        const view = frame({ allowed: true, theme: true, sounds: true });
        view.unmount();
        expect(document.documentElement.dataset.season).toBeUndefined();
        expect(soundSeason()).toBeNull();
    });
});

describe("the preferences card", () => {
    it("says which season is on and until when", () => {
        render(withMessages(<SeasonalCard allowed initial={SEASONAL_DEFAULTS} />));
        expect(screen.getByText(/On now: Halloween, until/)).toBeDefined();
    });

    it("names the next season on an ordinary day", () => {
        vi.setSystemTime(new Date(2026, 5, 15, 12));
        render(withMessages(<SeasonalCard allowed initial={SEASONAL_DEFAULTS} />));
        expect(screen.getByText(/Next: Halloween/)).toBeDefined();
    });

    it("saves a switch at once, and puts it back when the save is refused", async () => {
        save.mockResolvedValue({ error: "Your choice could not be saved. Try again in a moment." });
        render(withMessages(<SeasonalCard allowed initial={SEASONAL_DEFAULTS} />));
        const sounds = screen.getByRole("switch", { name: "Seasonal sounds" });
        act(() => fireEvent.click(sounds));
        expect(save).toHaveBeenCalledWith({ sounds: true });
        await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("could not be saved"));
        expect(sounds.getAttribute("aria-checked")).toBe("false");
    });

    it("cannot be moved while the operator has seasons off, and says who did it", () => {
        render(withMessages(<SeasonalCard allowed={false} initial={SEASONAL_DEFAULTS} />));
        const decorations = screen.getByRole("switch", { name: "Decorations" });
        expect(decorations.hasAttribute("disabled")).toBe(true);
        expect(decorations.getAttribute("aria-checked")).toBe("false");
        expect(screen.getByText(/An administrator turned seasonal themes off/)).toBeDefined();
        // And it does not announce a season nobody here will see.
        expect(screen.queryByText(/On now/)).toBeNull();
    });
});
