// @vitest-environment jsdom

/**
 * Several places inside one country: on the whole map they are one marker with
 * their count, pressing it zooms in until each has its own, and each can then be
 * picked. Places no zoom can part (one town, or a country with no town) are laid
 * out around their spot instead. Every control reads as words in both languages.
 */

import type { Locale } from "@polaris/core";
import { webCatalogs } from "../../../messages";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n/i18n-provider";
import { WorldMap, type MapPlace } from "@/components/map/world-map";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

afterEach(cleanup);

const PLACES: MapPlace[] = [
    { id: "mad", label: "Madrid", country: "ES", latitude: 40.42, longitude: -3.7 },
    { id: "bcn", label: "Barcelona", country: "ES", latitude: 41.39, longitude: 2.17 },
    { id: "vlc", label: "Valencia", country: "ES", latitude: 39.47, longitude: -0.38 },
    // Known only by its country: drawn at the middle of Spain, next to Madrid.
    { id: "es", label: "Somewhere in Spain", country: "ES" }
];

function draw(onSelect = vi.fn(), selected: string | null = null, locale: Locale = "en-US") {
    render(
        <I18nProvider locale={locale} messages={webCatalogs.pick(locale, ["components"])}>
            <WorldMap label="Exits" places={PLACES} selected={selected} onSelect={onSelect} />
        </I18nProvider>
    );
    return onSelect;
}

describe("the map with several places in one country", () => {
    it("groups them on the whole map, then parts them when the group is pressed", async () => {
        const onSelect = draw();
        const group = await screen.findByRole("button", { name: /^4 places: / });
        expect(screen.queryByRole("button", { name: "Barcelona" })).toBeNull();

        fireEvent.click(group);
        const barcelona = await screen.findByRole("button", { name: "Barcelona" });
        expect(screen.getByRole("button", { name: "Valencia" })).toBeTruthy();
        // Madrid and the place with no town sit on one spot: still a group of two.
        const pair = screen.getByRole("button", { name: /^2 places: / });

        fireEvent.click(barcelona);
        expect(onSelect).toHaveBeenLastCalledWith("bcn");

        fireEvent.click(pair);
        fireEvent.click(await screen.findByRole("button", { name: "Madrid" }));
        expect(onSelect).toHaveBeenLastCalledWith("mad");
        fireEvent.click(screen.getByRole("button", { name: "Somewhere in Spain" }));
        expect(onSelect).toHaveBeenLastCalledWith("es");
    });

    it("picks with the keyboard and says which one is picked", async () => {
        const onSelect = draw(vi.fn(), "vlc");
        fireEvent.keyDown(await screen.findByRole("button", { name: /^4 places: / }), {
            key: "Enter"
        });
        const valencia = await screen.findByRole("button", { name: "Valencia" });
        expect(valencia.getAttribute("aria-pressed")).toBe("true");
        expect(screen.getByRole("button", { name: "Barcelona" }).getAttribute("aria-pressed")).toBe(
            "false"
        );
        fireEvent.keyDown(screen.getByRole("button", { name: "Barcelona" }), { key: " " });
        expect(onSelect).toHaveBeenLastCalledWith("bcn");
    });

    it("zooms with its buttons and the keyboard, and goes back to the whole world", async () => {
        draw();
        const map = await screen.findByRole("group", { name: "Exits" });
        const zoomOut = screen.getByRole("button", { name: "Zoom out" }) as HTMLButtonElement;
        expect(zoomOut.disabled).toBe(true);
        expect(screen.queryByRole("button", { name: "Whole map" })).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
        expect(zoomOut.disabled).toBe(false);
        fireEvent.keyDown(map, { key: "0" });
        await waitFor(() => expect(zoomOut.disabled).toBe(true));
        fireEvent.keyDown(map, { key: "+" });
        await waitFor(() => expect(zoomOut.disabled).toBe(false));
        fireEvent.click(screen.getByRole("button", { name: "Whole map" }));
        await waitFor(() => expect(zoomOut.disabled).toBe(true));
    });

    it("reads as words in Spanish", async () => {
        draw(vi.fn(), null, "es-ES");
        expect(await screen.findByRole("button", { name: /^4 lugares: / })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Acercar" })).toBeTruthy();
        expect(document.body.textContent ?? "").not.toMatch(/components\.|map\./);
    });
});

describe("pressing land", () => {
    it("says which country and where", async () => {
        const onPick = vi.fn();
        render(
            <I18nProvider locale="en-US" messages={webCatalogs.pick("en-US", ["components"])}>
                <WorldMap label="Where" onPick={onPick} pickable={(code) => code === "PT"} />
            </I18nProvider>
        );
        const portugal = await screen.findByRole("button", { name: "Portugal" });
        expect(screen.queryByRole("button", { name: "Spain" })).toBeNull();
        fireEvent.keyDown(portugal, { key: "Enter" });
        const pick = onPick.mock.calls[0]?.[0] as {
            country: string;
            latitude: number;
            longitude: number;
        };
        expect(pick.country).toBe("PT");
        expect(pick.latitude).toBeGreaterThan(36);
        expect(pick.latitude).toBeLessThan(43);
        expect(pick.longitude).toBeGreaterThan(-10);
        expect(pick.longitude).toBeLessThan(-6);
    });
});
