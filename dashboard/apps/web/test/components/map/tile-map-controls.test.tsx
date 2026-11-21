// @vitest-environment jsdom

/**
 * The full map zooms with the wheel and moves with a drag, and its credit to
 * OpenStreetMap is folded into an "i" that opens it - kept, as the licence asks.
 */

import { MessagesWrapper } from "../../setup/i18n";
import { TileMap } from "@/components/map/tile-map";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const MADRID = { latitude: 40.4168, longitude: -3.7038 };

function zoomOf(container: HTMLElement): string | undefined {
    return container.querySelector("img")?.getAttribute("src")?.split("/").at(-3);
}

afterEach(cleanup);

describe("the street map", () => {
    it("credits OpenStreetMap behind a button that opens the line", () => {
        render(<TileMap points={[MADRID]} />, { wrapper: MessagesWrapper });
        expect(screen.queryByRole("link")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Map credits" }));
        expect(screen.getByRole("link").getAttribute("href")).toBe("https://www.openstreetmap.org/copyright");
    });

    it("zooms in with the wheel when it is a full map", () => {
        const { container } = render(<TileMap points={[MADRID]} zoom={12} controls />, { wrapper: MessagesWrapper });
        const map = container.firstElementChild as HTMLElement;
        fireEvent.wheel(map, { deltaY: -120 });
        expect(zoomOf(container)).toBe("13");
    });

    it("leaves the wheel to the page for a map in a card", () => {
        const { container } = render(<TileMap points={[MADRID]} zoom={12} />, { wrapper: MessagesWrapper });
        fireEvent.wheel(container.firstElementChild as HTMLElement, { deltaY: -120 });
        expect(zoomOf(container)).toBe("12");
    });
});
