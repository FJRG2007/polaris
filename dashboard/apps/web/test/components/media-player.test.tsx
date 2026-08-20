// @vitest-environment jsdom

/**
 * What the player is built with, which is the half nobody sees until it is
 * wrong.
 *
 * Two of these settings are the difference between a player and a rectangle
 * with a picture in it. A video opened over the conversation has to take the
 * space bar - it IS the screen at that moment - while a player sitting in a list
 * of messages must not, because space is how a page scrolls and forty of them
 * would fight over it. And a player with somewhere to save from has to say so:
 * Polaris replaced the browser's own menu, so a player with no download control
 * is a file with no way out.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

/** What the player was constructed with, for the last one built. */
let built: { options: Record<string, unknown> } | null = null;

vi.mock("plyr", () => ({
    default: class {
        constructor(_element: unknown, options: Record<string, unknown>) {
            built = { options };
        }
        destroy() {}
    }
}));

const { MediaPlayer } = await import("@/components/media-player");

afterEach(() => {
    cleanup();
    built = null;
});

describe("the keys it answers to", () => {
    it("leaves the space bar to the page it is drawn in", async () => {
        render(<MediaPlayer kind="video" src="/api/chat/attachments/a1" />);
        await waitFor(() => expect(built).not.toBeNull());
        expect(built?.options.keyboard).toEqual({ focused: true, global: false });
    });

    it("takes it for a player that is the screen", async () => {
        render(<MediaPlayer kind="video" src="/api/chat/attachments/a1" keyboard="global" />);
        await waitFor(() => expect(built).not.toBeNull());
        expect(built?.options.keyboard).toEqual({ focused: true, global: true });
    });
});

describe("saving what it is playing", () => {
    it("offers it where the screen said it may be saved", async () => {
        render(
            <MediaPlayer
                kind="video"
                src="/api/chat/attachments/a1"
                download="/api/chat/attachments/a1?download=1"
            />
        );
        await waitFor(() => expect(built).not.toBeNull());
        expect(built?.options.controls).toContain("download");
        // Pointed somewhere other than what is being played: one is served to be
        // played and the other as a file to save.
        expect(built?.options.urls).toEqual({
            download: "/api/chat/attachments/a1?download=1"
        });
    });

    it("offers nothing of the sort otherwise", async () => {
        render(<MediaPlayer kind="video" src="/api/chat/attachments/a1" />);
        await waitFor(() => expect(built).not.toBeNull());
        expect(built?.options.controls).not.toContain("download");
        expect(built?.options.urls).toBeUndefined();
    });
});

describe("what it stores about the person watching", () => {
    it("stores nothing", async () => {
        // A file on their own instance. There is no session to remember here and
        // nothing worth writing down about who watched what.
        render(<MediaPlayer kind="video" src="/api/chat/attachments/a1" />);
        await waitFor(() => expect(built).not.toBeNull());
        expect(built?.options.storage).toEqual({ enabled: false });
    });
});
