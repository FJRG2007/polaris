// @vitest-environment jsdom

/**
 * The full map zooms with the wheel and moves with a drag, switches between
 * streets, hybrid and satellite, and credits its sources the way Apple Maps
 * does: a quiet "Legal" text link that opens the full lines - never an icon.
 */

import { MessagesWrapper } from "../../setup/i18n";
import { MapStyleSwitch } from "@/app/(app)/chat/location-viewer";
import { TileMap } from "@/components/map/tile-map";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/app/(app)/chat/actions", () => ({ locationAddressAction: async () => ({ address: null }) }));

const MADRID = { latitude: 40.4168, longitude: -3.7038 };

function zoomOf(container: HTMLElement): string | undefined {
    return container.querySelector("img")?.getAttribute("src")?.split("/").at(-3);
}

afterEach(cleanup);

describe("the street map", () => {
    it("credits OpenStreetMap behind a small Legal text link, not an icon", () => {
        render(<TileMap points={[MADRID]} />, { wrapper: MessagesWrapper });
        expect(screen.queryByRole("link")).toBeNull();
        const legal = screen.getByRole("button", { name: "Map credits" });
        expect(legal.textContent).toBe("Legal");
        expect(legal.querySelector("svg")).toBeNull();
        fireEvent.click(legal);
        expect(screen.getByRole("link").getAttribute("href")).toBe("https://www.openstreetmap.org/copyright");
    });

    it("credits the imagery and its labels on a hybrid map", () => {
        render(<TileMap points={[MADRID]} style="hybrid" />, { wrapper: MessagesWrapper });
        fireEvent.click(screen.getByRole("button", { name: "Map credits" }));
        const links = screen.getAllByRole("link").map((link) => link.getAttribute("href"));
        expect(links).toEqual(["https://s2maps.eu", "https://maps.eox.at"]);
        expect(screen.getByText(/CC BY 4.0/)).toBeTruthy();
    });

    it("draws satellite tiles through Polaris at the zoom asked for", () => {
        const { container } = render(<TileMap points={[MADRID]} zoom={17} style="satellite" />, {
            wrapper: MessagesWrapper
        });
        const sources = [...container.querySelectorAll("img")].map((img) => img.getAttribute("src") ?? "");
        expect(sources.length).toBeGreaterThan(0);
        expect(
            sources.every((src) => src.startsWith("/api/chat/location/tile/17/") && src.endsWith("?layer=imagery&v=default"))
        ).toBe(true);
    });

    it("zooms past the imagery's deepest level by stretching it, never stopping short", () => {
        const { container } = render(<TileMap points={[MADRID]} zoom={21} style="hybrid" zoomButtons />, {
            wrapper: MessagesWrapper
        });
        const images = [...container.querySelectorAll("img")];
        const imagery = images.filter((img) => img.getAttribute("src")?.includes("layer=imagery"));
        const labels = images.filter((img) => img.getAttribute("src")?.endsWith("?layer=labels"));
        // The default draws to 18 and its labels to 14; zoom 21 stretches both.
        expect(imagery.every((img) => img.getAttribute("src")?.startsWith("/api/chat/location/tile/18/"))).toBe(true);
        expect(imagery[0]?.getAttribute("width")).toBe(String(256 * 2 ** 3));
        expect(labels.length).toBeGreaterThan(0);
        expect(labels.every((img) => img.getAttribute("src")?.startsWith("/api/chat/location/tile/14/"))).toBe(true);
        expect(screen.getByRole("button", { name: "Zoom in" }).hasAttribute("disabled")).toBe(true);
        expect(screen.getByRole("button", { name: "Zoom out" }).hasAttribute("disabled")).toBe(false);
    });

    it("lays the labels over the imagery on a hybrid map, stretched past their last zoom", () => {
        const { container } = render(<TileMap points={[MADRID]} zoom={15} style="hybrid" />, {
            wrapper: MessagesWrapper
        });
        const labels = [...container.querySelectorAll("img")].filter((img) => img.getAttribute("src")?.endsWith("?layer=labels"));
        expect(labels.length).toBeGreaterThan(0);
        expect(labels[0]!.getAttribute("src")).toMatch(/^\/api\/chat\/location\/tile\/14\//);
        expect(labels[0]!.getAttribute("width")).toBe("512");
    });

    it("switches style from the Map | Hybrid | Satellite pill", () => {
        const picked: string[] = [];
        render(<MapStyleSwitch value="map" onChange={(style) => picked.push(style)} />, { wrapper: MessagesWrapper });
        expect(screen.getByRole("radio", { name: "Map" }).getAttribute("aria-checked")).toBe("true");
        fireEvent.click(screen.getByRole("radio", { name: "Satellite" }));
        fireEvent.click(screen.getByRole("radio", { name: "Hybrid" }));
        expect(picked).toEqual(["satellite", "hybrid"]);
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
