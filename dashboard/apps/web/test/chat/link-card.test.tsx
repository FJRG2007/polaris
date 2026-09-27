// @vitest-environment jsdom

/**
 * The card under a link: a player for the sites Polaris can play, the ordinary
 * card for everything else.
 *
 * Three promises are asserted here rather than in the parser's tests, because
 * they are about what the screen does with its answer: no frame exists until
 * play is pressed, the room a player takes is reserved before it arrives (so a
 * TikTok is upright before and after), and a link Polaris cannot play still gets
 * the card it always did.
 */

import userEvent from "@testing-library/user-event";
import { LinkCard } from "@/app/(app)/chat/link-card";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

afterEach(cleanup);

function preview(url: string, title = "A title") {
    return {
        id: "p1",
        url,
        title,
        author: "Someone",
        accent: null,
        siteName: "A site",
        hasImage: true,
        description: "What it is about"
    };
}

describe("a link Polaris can play", () => {
    it("loads nothing from the site until play is pressed", async () => {
        const { container } = render(
            <LinkCard
                preview={preview("https://www.tiktok.com/@someone/video/7232918429372394779")}
            />
        );
        expect(container.querySelector("iframe")).toBeNull();

        const play = screen.getByRole("button", { name: "Play this on TikTok, here" });
        await userEvent.click(play);

        const frame = container.querySelector("iframe");
        expect(frame?.getAttribute("src")).toBe(
            "https://www.tiktok.com/player/v1/7232918429372394779?autoplay=1"
        );
        // Enough for a player, and not forms or navigating Polaris' own tab.
        const sandbox = frame?.getAttribute("sandbox") ?? "";
        expect(sandbox).toContain("allow-scripts");
        expect(sandbox).not.toContain("allow-top-navigation");
        expect(sandbox).not.toContain("allow-forms");
    });

    it("keeps a vertical video upright before and after play", async () => {
        const { container } = render(
            <LinkCard preview={preview("https://www.youtube.com/shorts/dQw4w9WgXcQ")} />
        );
        const play = screen.getByRole("button", { name: "Play this on YouTube, here" });
        expect(play.className).toContain("aspect-[9/16]");

        await userEvent.click(play);
        expect(container.querySelector("iframe")?.className).toContain("aspect-[9/16]");
    });

    it("gives each kind of player its own room", () => {
        const shapes: Array<[string, string]> = [
            ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "aspect-video"],
            ["https://www.instagram.com/reel/CxYz123AbC_/", "h-[32rem]"],
            ["https://x.com/someone/status/1700000000000000000", "h-[32rem]"],
            ["https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT", "h-[166px]"]
        ];
        for (const [url, room] of shapes) {
            render(<LinkCard preview={preview(url)} />);
            expect(screen.getByRole("button").className, url).toContain(room);
            cleanup();
        }
    });

    it("tells Twitch which site it is being shown on", async () => {
        const { container } = render(
            <LinkCard preview={preview("https://www.twitch.tv/somestreamer")} />
        );
        await userEvent.click(screen.getByRole("button", { name: "Play this on Twitch, here" }));
        expect(container.querySelector("iframe")?.getAttribute("src")).toBe(
            `https://player.twitch.tv/?channel=somestreamer&autoplay=true&parent=${window.location.hostname}`
        );
    });
});

describe("a link Polaris cannot play", () => {
    it("is the ordinary card, with its description", () => {
        const { container } = render(<LinkCard preview={preview("https://example.com/article")} />);
        expect(screen.queryByRole("button")).toBeNull();
        expect(container.querySelector("iframe")).toBeNull();
        expect(screen.getByRole("link").getAttribute("href")).toBe("https://example.com/article");
        expect(screen.getByText("What it is about")).toBeTruthy();
    });

    it("includes a share-button short link, which names nothing on its own", () => {
        render(<LinkCard preview={preview("https://vm.tiktok.com/ZMabcdef/")} />);
        expect(screen.queryByRole("button")).toBeNull();
        expect(screen.getByRole("link").getAttribute("href")).toBe(
            "https://vm.tiktok.com/ZMabcdef/"
        );
    });
});
