// @vitest-environment jsdom

/**
 * The card for somebody playing on a server here.
 *
 * The server's own picture when it has one, with the game's mark small in its
 * corner; the game's mark on its own when the picture does not load. The line
 * under a name says what they are doing in the reader's language.
 */

import type { ActivityView } from "@polaris/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessagesWrapper, withMessages } from "../setup/i18n";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/components/presence", () => ({ useNow: () => Date.now() }));
vi.mock("@/components/session-scope", () => ({ useSessionScope: () => "viewer" }));
vi.mock("@/components/listen-along-button", () => ({ ListenAlongButton: () => null }));

const { ActivityCard, ActivityMark, activityLine } = await import("@/components/activity-card");
const { translate } = await import("@/lib/i18n/translate");

const playing: ActivityView = {
    source: "minecraft",
    key: "server:ExampleSMP",
    name: "Minecraft",
    details: "ExampleSMP",
    state: "",
    imageUrl: "/api/apps/installed/s1/minecraft/card-icon",
    linkUrl: null,
    startedAt: new Date().toISOString(),
    endsAt: null,
    gameId: "minecraft"
};

afterEach(cleanup);

function images(container: HTMLElement): string[] {
    return [...container.querySelectorAll("img")].map((img) => img.getAttribute("src") ?? "");
}

describe("the card for a game server", () => {
    it("shows the server's picture with the game's mark in the corner", () => {
        const { container } = render(<ActivityCard activity={playing} />, {
            wrapper: MessagesWrapper
        });
        expect(images(container)).toEqual([
            "/api/apps/installed/s1/minecraft/card-icon",
            "/logos/minecraft.webp"
        ]);
        expect(screen.getByText("ExampleSMP")).toBeTruthy();
    });

    it("falls back to the game's mark alone when the server has no picture", () => {
        const { container } = render(<ActivityCard activity={playing} />, {
            wrapper: MessagesWrapper
        });
        fireEvent.error(container.querySelector("img")!);
        expect(images(container)).toEqual(["/logos/minecraft.webp"]);
    });

    it("shows the game's mark when no picture was given at all", () => {
        const { container } = render(<ActivityCard activity={{ ...playing, imageUrl: null }} />, {
            wrapper: MessagesWrapper
        });
        expect(images(container)).toEqual(["/logos/minecraft.webp"]);
    });

    it("reads in Spanish", () => {
        render(withMessages(<ActivityCard activity={playing} />, "es-ES"));
        expect(screen.getByLabelText("Jugando a Minecraft")).toBeTruthy();
    });
});

describe("a game on somebody's computer", () => {
    const rocket: ActivityView = {
        source: "game",
        key: "rocketleague.exe",
        name: "Rocket League",
        details: "",
        state: "",
        imageUrl: "/api/activity/game-art/steam%3A252950",
        linkUrl: null,
        startedAt: new Date().toISOString(),
        endsAt: null
    };

    it("shows the picture this server keeps for it, on the card and in a row", () => {
        const card = render(<ActivityCard activity={rocket} />, { wrapper: MessagesWrapper });
        expect(images(card.container)).toEqual(["/api/activity/game-art/steam%3A252950"]);
        // Box art is not pixel art.
        expect(card.container.querySelector("img")!.className).not.toContain("pixelated");
        cleanup();
        const row = render(<ActivityMark activity={rocket} />);
        expect(images(row.container)).toEqual(["/api/activity/game-art/steam%3A252950"]);
    });

    it("draws the game glyph, never a gap, when there is no picture or it fails", () => {
        const row = render(<ActivityMark activity={rocket} />);
        fireEvent.error(row.container.querySelector("img")!);
        expect(images(row.container)).toEqual([]);
        expect(row.container.querySelector("svg")).toBeTruthy();
        cleanup();
        const none = render(<ActivityMark activity={{ ...rocket, imageUrl: null }} />);
        expect(none.container.querySelector("svg")).toBeTruthy();
    });

    it("never puts a track's cover in a row's mark", () => {
        const row = render(<ActivityMark activity={{ ...rocket, source: "spotify", imageUrl: "https://i.scdn.co/image/x" }} />);
        expect(images(row.container)).toEqual([]);
    });

    it("reads in Spanish", () => {
        render(withMessages(<ActivityCard activity={rocket} />, "es-ES"));
        expect(screen.getByLabelText("Jugando a Rocket League")).toBeTruthy();
    });
});

describe("the line under a name", () => {
    it("says what they are doing in the reader's language", () => {
        const es = (key: string, params?: Record<string, string>) =>
            translate("es-ES", `components.${key}` as never, params as never);
        expect(activityLine(playing, es as never)).toBe("Jugando a Minecraft");
        expect(activityLine({ source: "spotify", name: "Clocks" }, es as never)).toBe(
            "Escuchando Clocks"
        );
    });
});
