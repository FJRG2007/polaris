// @vitest-environment jsdom

/**
 * A song that came from Last.fm, on the same card as a Spotify one.
 *
 * What is pinned: it says it is music rather than Spotify, and instead of a
 * Listen along that cannot follow it, it offers to open the song in Spotify -
 * saying that it starts from the beginning.
 */

import type { ActivityView } from "@polaris/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessagesWrapper, withMessages } from "../setup/i18n";
import { cleanup, render, screen } from "@testing-library/react";

const scrobbled: ActivityView = {
    source: "spotify",
    key: "lastfm:example artist|example song",
    name: "Example Song",
    details: "Example Artist",
    state: "Example Album",
    imageUrl: null,
    linkUrl: "https://www.last.fm/music/Example+Artist/_/Example+Song",
    startedAt: new Date().toISOString(),
    endsAt: null
};

vi.mock("@/components/presence", () => ({ useNow: () => Date.now() }));
vi.mock("@/components/session-scope", () => ({ useSessionScope: () => "viewer" }));
vi.mock("@/components/listen-along-button", () => ({ ListenAlongButton: () => <span>synced button</span> }));
vi.mock("@/components/presence-store", () => ({ usePresence: () => ({ activity: [scrobbled] }) }));

const { ActivityCards } = await import("@/components/activity-card");

afterEach(cleanup);

describe("a song from Last.fm", () => {
    it("opens in Spotify from the start instead of listening along", () => {
        render(<ActivityCards personId="host" />, { wrapper: MessagesWrapper });
        expect(screen.queryByText("synced button")).toBeNull();
        const open = screen.getByRole("link", { name: /Play in Spotify/ });
        expect(open.getAttribute("href")).toBe(
            "https://open.spotify.com/search/Example%20Song%20Example%20Artist"
        );
        expect(screen.getByText(/from the beginning/i)).toBeTruthy();
        expect(screen.getByText("Listening to music")).toBeTruthy();
    });

    it("offers nothing on somebody's own song", () => {
        render(<ActivityCards personId="viewer" />, { wrapper: MessagesWrapper });
        expect(screen.queryByRole("link", { name: /Play in Spotify/ })).toBeNull();
    });

    it("reads in Spanish", () => {
        render(withMessages(<ActivityCards personId="host" />, "es-ES"));
        expect(screen.getByRole("link", { name: /Abrir en Spotify/ })).toBeTruthy();
    });
});
