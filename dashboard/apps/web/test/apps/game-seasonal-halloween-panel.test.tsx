// @vitest-environment jsdom

/**
 * Halloween's extras inside the seasonal card: every one of them is there with
 * its own control, a switch changes only itself, and nothing can be changed
 * while the card is waiting on the server.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@polaris/app-host/client", () => ({
    hostUi: {
        i18nProvider: { useLocale: () => "en-US" },
        liveRead: { useKeptSnapshot: () => undefined },
        snapshotCache: { readSnapshot: () => null, writeSnapshot: () => undefined }
    }
}));

const { MinecraftSeasonalHalloween } = await import(
    "@polaris-app/game-servers/src/screens/installed/minecraft-seasonal-halloween"
);
const halloween = await import("@polaris-app/game-servers/src/lib/minecraft/seasonal-halloween");

afterEach(cleanup);

/** A stand-in for the card's amount picker: a labelled number. */
function Choice({ id, label, value }: { id: string; label: string; value: number }) {
    return (
        <output id={id} aria-label={label}>
            {value}
        </output>
    );
}

function panel(disabled = false) {
    const onChange = vi.fn();
    render(
        <MinecraftSeasonalHalloween
            installedAppId="server-1"
            value={halloween.DEFAULT_HALLOWEEN}
            times={(count) => `${count}x`}
            Choice={Choice}
            disabled={disabled}
            onChange={onChange}
        />
    );
    return onChange;
}

describe("the Halloween extras", () => {
    it("shows an amount for each amount and a switch for each switch", () => {
        panel();
        for (const label of ["Witches", "Bat swarms", "Trap pumpkins", "Graveyards"]) {
            expect(screen.getByLabelText(label)).toBeTruthy();
        }
        expect(screen.getAllByRole("switch")).toHaveLength(halloween.HALLOWEEN_SWITCHES.length);
        expect(screen.getByRole("switch", { name: "Phantoms" }).getAttribute("aria-checked")).toBe(
            "false"
        );
        expect(
            screen.getByRole("switch", { name: "Blood night" }).getAttribute("aria-checked")
        ).toBe("true");
    });

    it("changes only the switch that was flipped", () => {
        const onChange = panel();
        fireEvent.click(screen.getByRole("switch", { name: "Phantoms" }));
        expect(onChange).toHaveBeenCalledWith({ phantoms: true });
    });

    it("takes no change while the card cannot save", () => {
        const onChange = panel(true);
        fireEvent.click(screen.getByRole("switch", { name: "Treats" }));
        expect(onChange).not.toHaveBeenCalled();
    });
});
