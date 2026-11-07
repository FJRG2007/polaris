// @vitest-environment jsdom
/**
 * The Themes & add-ons gallery: every item with its screenshot, and the kind
 * filter narrowing the list, in both languages.
 */

import type { ReactNode } from "react";
import { I18nContext } from "../../src/i18n";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TvGallery, type TvGalleryItem } from "../../src/tv-compat/tv-gallery";
import en from "../../../../apps/web/messages/en-US/tvCompat.json" with { type: "json" };
import es from "../../../../apps/web/messages/es-ES/tvCompat.json" with { type: "json" };

const ITEMS: TvGalleryItem[] = [
    {
        id: "aurora",
        kind: "theme",
        name: "Aurora",
        description: "A dark aurora",
        network: false,
        minSdk: 26,
        screenshot: "theme-aurora.jpg"
    },
    {
        id: "storm",
        kind: "theme",
        name: "Storm",
        description: "Rain and lightning",
        network: false,
        minSdk: 26,
        screenshot: "theme-storm.jpg"
    },
    {
        id: "weather",
        kind: "addon",
        name: "Weather",
        description: "The weather for one city",
        network: true,
        minSdk: 28,
        screenshot: "addon-weather.jpg"
    }
];

function wrap(node: ReactNode, locale: "en-US" | "es-ES" = "en-US") {
    const tvCompat = locale === "es-ES" ? es : en;
    return (
        <I18nContext.Provider value={{ locale, messages: { tvCompat } }}>
            {node}
        </I18nContext.Provider>
    );
}

const src = (item: TvGalleryItem) => `/tv/${item.screenshot}`;

afterEach(cleanup);

describe("TvGallery", () => {
    it("shows every item with its screenshot", () => {
        render(wrap(<TvGallery items={ITEMS} screenshotSrc={src} />));
        expect(screen.getAllByRole("listitem")).toHaveLength(3);
        const shot = screen.getByAltText("Weather on a TV") as HTMLImageElement;
        expect(shot.getAttribute("src")).toBe("/tv/addon-weather.jpg");
        expect(screen.getByText("Uses the internet")).toBeTruthy();
        expect(screen.getByText("Android 9+")).toBeTruthy();
    });

    it("filters by kind and says how many of each", () => {
        render(wrap(<TvGallery items={ITEMS} screenshotSrc={src} />));
        fireEvent.click(screen.getByRole("button", { name: "Add-ons (1)" }));
        expect(screen.getAllByRole("listitem")).toHaveLength(1);
        expect(
            screen.getByRole("button", { name: "Add-ons (1)" }).getAttribute("aria-pressed")
        ).toBe("true");
        fireEvent.click(screen.getByRole("button", { name: "Themes (2)" }));
        expect(screen.getAllByRole("listitem")).toHaveLength(2);
        expect(screen.queryByText("Weather")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "All (3)" }));
        expect(screen.getAllByRole("listitem")).toHaveLength(3);
    });

    it("says so when there is nothing to show", () => {
        render(wrap(<TvGallery items={[]} screenshotSrc={src} />));
        expect(screen.getByText("Nothing to show yet.")).toBeTruthy();
        expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    });

    it("speaks Spanish", () => {
        render(wrap(<TvGallery items={ITEMS} screenshotSrc={src} />, "es-ES"));
        expect(screen.getByRole("button", { name: "Complementos (1)" })).toBeTruthy();
        expect(screen.getByAltText("Weather en un televisor")).toBeTruthy();
        expect(screen.getAllByText("Va sin conexión")).toHaveLength(2);
    });
});
