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

import { MessagesWrapper } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import { LinkCard } from "@/app/(app)/chat/link-card";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

function preview(url: string, title = "A title", target: string | null = null) {
    return {
        id: "p1",
        url,
        target,
        title,
        author: "Someone",
        accent: null,
        siteName: "A site",
        hasImage: true,
        description: "What it is about",
        steam: null
    };
}

describe("a link Polaris can play", () => {
    it("loads nothing from the site until play is pressed", async () => {
        const { container } = render(
            <LinkCard
                preview={preview("https://www.tiktok.com/@someone/video/7232918429372394779")}
            />,
            { wrapper: MessagesWrapper }
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
            <LinkCard preview={preview("https://www.youtube.com/shorts/dQw4w9WgXcQ")} />,
            { wrapper: MessagesWrapper }
        );
        const play = screen.getByRole("button", { name: "Play this on YouTube, here" });
        expect(play.className).toContain("aspect-[9/16]");

        await userEvent.click(play);
        expect(container.querySelector("iframe")?.className).toContain("aspect-[9/16]");
    });

    it("gives each kind of player its own room", () => {
        const shapes: Array<[string, string]> = [
            ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "aspect-video"],
            ["https://www.twitch.tv/somestreamer", "min-h-[300px]"],
            ["https://www.instagram.com/reel/CxYz123AbC_/", "h-[32rem]"],
            ["https://x.com/someone/status/1700000000000000000", "h-[32rem]"],
            ["https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT", "h-[166px]"]
        ];
        for (const [url, room] of shapes) {
            render(<LinkCard preview={preview(url)} />, { wrapper: MessagesWrapper });
            expect(screen.getByRole("button").className, url).toContain(room);
            cleanup();
        }
    });

    it("tells Twitch which site it is being shown on", async () => {
        const { container } = render(
            <LinkCard preview={preview("https://www.twitch.tv/somestreamer")} />,
            { wrapper: MessagesWrapper }
        );
        await userEvent.click(screen.getByRole("button", { name: "Play this on Twitch, here" }));
        expect(container.querySelector("iframe")?.getAttribute("src")).toBe(
            `https://player.twitch.tv/?channel=somestreamer&autoplay=true&parent=${window.location.hostname}`
        );
    });
});

describe("an upright video's card", () => {
    it("is as wide as the video, not as a landscape card", async () => {
        const { container } = render(
            <LinkCard
                preview={preview("https://www.tiktok.com/@someone/video/7232918429372394779")}
            />,
            { wrapper: MessagesWrapper }
        );
        const card = container.firstElementChild as HTMLElement;
        expect(card.className).toContain("w-[calc(min(325px,70dvh*9/16)_+_1rem_+_3px)]");
        expect(card.className).toContain("max-w-full");
        expect(card.className).not.toContain("max-w-lg");
        await userEvent.click(screen.getByRole("button", { name: "Play this on TikTok, here" }));
        expect(container.querySelector("iframe")?.className).toContain("w-full");
    });

    it("leaves a landscape player's card as it was", () => {
        const { container } = render(
            <LinkCard preview={preview("https://www.youtube.com/watch?v=dQw4w9WgXcQ")} />,
            { wrapper: MessagesWrapper }
        );
        expect((container.firstElementChild as HTMLElement).className).toContain("max-w-lg");
    });
});

describe("a TikTok player that could not play", () => {
    const failure = {
        type: "onPlayerError",
        value: { errorCode: 3001, errorType: "PLAYBACK_ERROR" },
        "x-tiktok-player": true
    };

    function from(frame: HTMLIFrameElement | null, origin = "https://www.tiktok.com") {
        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: failure,
                    origin,
                    source: frame?.contentWindow ?? null
                })
            );
        });
    }

    it("is loaded once more, and only once", async () => {
        const { container } = render(
            <LinkCard
                preview={preview("https://www.tiktok.com/@someone/video/7232918429372394779")}
            />,
            { wrapper: MessagesWrapper }
        );
        await userEvent.click(screen.getByRole("button", { name: "Play this on TikTok, here" }));
        const first = container.querySelector("iframe");

        from(first);
        const second = container.querySelector("iframe");
        expect(second).not.toBe(first);
        expect(second?.getAttribute("src")).toBe(
            "https://www.tiktok.com/player/v1/7232918429372394779?autoplay=1"
        );

        from(second);
        expect(container.querySelector("iframe")).toBe(second);
    });

    it("is not reloaded by a message from another frame or another site", async () => {
        const { container } = render(
            <LinkCard
                preview={preview("https://www.tiktok.com/@someone/video/7232918429372394779")}
            />,
            { wrapper: MessagesWrapper }
        );
        await userEvent.click(screen.getByRole("button", { name: "Play this on TikTok, here" }));
        const frame = container.querySelector("iframe");

        from(null);
        from(frame, "https://evil.example");
        expect(container.querySelector("iframe")).toBe(frame);
    });
});

describe("a TikTok player's sound", () => {
    const said = (type: string, value: unknown) => ({ type, value, "x-tiktok-player": true });

    function from(frame: HTMLIFrameElement | null, data: unknown) {
        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data,
                    origin: "https://www.tiktok.com",
                    source: frame?.contentWindow ?? null
                })
            );
        });
    }

    async function play() {
        const rendered = render(
            <LinkCard
                preview={preview("https://www.tiktok.com/@someone/video/7232918429372394779")}
            />,
            { wrapper: MessagesWrapper }
        );
        await userEvent.click(screen.getByRole("button", { name: "Play this on TikTok, here" }));
        const frame = rendered.container.querySelector("iframe");
        const told = vi.spyOn(frame!.contentWindow!, "postMessage").mockImplementation(() => {});
        return { frame, told };
    }

    // This runtime's jsdom has no local storage of its own.
    beforeEach(() => {
        const kept = new Map<string, string>();
        Object.defineProperty(window, "localStorage", {
            configurable: true,
            value: {
                getItem: (key: string) => kept.get(key) ?? null,
                setItem: (key: string, value: string) => void kept.set(key, value),
                removeItem: (key: string) => void kept.delete(key),
                clear: () => kept.clear()
            }
        });
    });

    it("comes on when the player starts muted, and the player's own mute is not remembered", async () => {
        const { frame, told } = await play();
        from(frame, said("onPlayerReady", undefined));
        from(frame, said("onMute", true));
        expect(told).toHaveBeenCalledWith(
            { type: "unMute", "x-tiktok-player": true },
            "https://www.tiktok.com"
        );
        from(frame, said("onMute", false));
        expect(window.localStorage.getItem("polaris.chat.embed-muted")).toBeNull();
    });

    it("remembers the reader muting it, and starts the next one muted", async () => {
        const first = await play();
        from(first.frame, said("onMute", true));
        from(first.frame, said("onMute", false));
        from(first.frame, said("onMute", true));
        expect(JSON.parse(window.localStorage.getItem("polaris.chat.embed-muted")!)).toEqual({
            "www.tiktok.com": true
        });
        cleanup();

        const next = await play();
        from(next.frame, said("onMute", true));
        expect(next.told).not.toHaveBeenCalled();
        // Unmuting it is remembered the same way.
        from(next.frame, said("onMute", false));
        expect(JSON.parse(window.localStorage.getItem("polaris.chat.embed-muted")!)).toEqual({
            "www.tiktok.com": false
        });
    });

    it("listens to no other frame or site", async () => {
        const { frame, told } = await play();
        from(null, said("onMute", true));
        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: said("onMute", true),
                    origin: "https://evil.example",
                    source: frame?.contentWindow ?? null
                })
            );
        });
        expect(told).not.toHaveBeenCalled();
    });
});

describe("a share-button short link", () => {
    it("plays where the server found it led, and still opens what was posted", async () => {
        const { container } = render(
            <LinkCard
                preview={preview(
                    "https://vm.tiktok.com/ZMabcdef/",
                    "A title",
                    "https://www.tiktok.com/@/video/7232918429372394779"
                )}
            />,
            { wrapper: MessagesWrapper }
        );
        expect(screen.getByRole("link").getAttribute("href")).toBe(
            "https://vm.tiktok.com/ZMabcdef/"
        );
        const play = screen.getByRole("button", { name: "Play this on TikTok, here" });
        expect(play.className).toContain("aspect-[9/16]");
        // Nothing from TikTok until it is asked for.
        expect(container.querySelector("iframe")).toBeNull();

        await userEvent.click(play);
        expect(container.querySelector("iframe")?.getAttribute("src")).toBe(
            "https://www.tiktok.com/player/v1/7232918429372394779?autoplay=1"
        );
    });
});

describe("a link Polaris cannot play", () => {
    it("is the ordinary card, with its description", () => {
        const { container } = render(
            <LinkCard preview={preview("https://example.com/article")} />,
            { wrapper: MessagesWrapper }
        );
        expect(screen.queryByRole("button")).toBeNull();
        expect(container.querySelector("iframe")).toBeNull();
        expect(screen.getByRole("link").getAttribute("href")).toBe("https://example.com/article");
        expect(screen.getByText("What it is about")).toBeTruthy();
    });

    it("includes a share-button short link the server has not followed yet", () => {
        render(<LinkCard preview={preview("https://vm.tiktok.com/ZMabcdef/")} />, {
            wrapper: MessagesWrapper
        });
        expect(screen.queryByRole("button")).toBeNull();
        expect(screen.getByRole("link").getAttribute("href")).toBe(
            "https://vm.tiktok.com/ZMabcdef/"
        );
    });

    it("includes a share link that led somewhere with no player - a profile", () => {
        render(
            <LinkCard
                preview={preview(
                    "https://vm.tiktok.com/ZMabcdef/",
                    "Someone",
                    "https://m.tiktok.com/h5/share/usr/6868799137997210630.html"
                )}
            />,
            { wrapper: MessagesWrapper }
        );
        expect(screen.queryByRole("button")).toBeNull();
    });

    it("includes Twitch on a page Twitch will not play in, but nothing else", () => {
        // Plain HTTP on a LAN address: Twitch refuses to play there, so a play
        // button would only lead to its refusal. Other players do not care.
        Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
        try {
            render(<LinkCard preview={preview("https://www.twitch.tv/somestreamer")} />, {
                wrapper: MessagesWrapper
            });
            expect(screen.queryByRole("button")).toBeNull();
            cleanup();
            render(<LinkCard preview={preview("https://youtu.be/dQw4w9WgXcQ")} />, {
                wrapper: MessagesWrapper
            });
            expect(screen.getByRole("button", { name: "Play this on YouTube, here" })).toBeTruthy();
        } finally {
            Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
        }
    });
});

describe("a Steam game", () => {
    function game(steam: Record<string, unknown>) {
        return {
            ...preview("https://store.steampowered.com/app/1145360/Hades/", "Hades"),
            siteName: "Steam",
            author: "Supergiant Games",
            steam: {
                kind: "steam" as const,
                appId: "1145360",
                free: false,
                price: null,
                comingSoon: false,
                releaseDate: "17 Sep, 2020",
                platforms: { windows: true, mac: true, linux: false },
                ...steam
            }
        };
    }

    it("shows the sale: the cut, the old price struck through, and the new one", () => {
        const { container } = render(
            <LinkCard preview={game({ price: { final: "6,12€", initial: "24,50€", discount: 75 } })} />,
            { wrapper: MessagesWrapper }
        );
        expect(screen.getByText("-75%")).toBeTruthy();
        expect(screen.getByText("24,50€").className).toContain("line-through");
        expect(screen.getByText("6,12€")).toBeTruthy();
        expect(screen.getByText("Released 17 Sep, 2020")).toBeTruthy();
        expect(screen.getByText("Windows")).toBeTruthy();
        expect(screen.getByText("macOS")).toBeTruthy();
        expect(screen.queryByText("Linux")).toBeNull();
        expect(screen.getByText("Steam - Supergiant Games")).toBeTruthy();
        // The whole card opens the store page, and the picture is Polaris' copy.
        const card = container.querySelector("a[data-card='steam']");
        expect(card?.getAttribute("href")).toBe("https://store.steampowered.com/app/1145360/Hades/");
        expect(container.querySelector("img")?.getAttribute("src")).toBe("/api/chat/links/p1/image");
    });

    it("says free to play instead of a price", () => {
        render(<LinkCard preview={game({ free: true })} />, { wrapper: MessagesWrapper });
        expect(screen.getByText("Free to play")).toBeTruthy();
    });

    it("shows a full price on its own", () => {
        render(<LinkCard preview={game({ price: { final: "59,99€", initial: "", discount: 0 } })} />, {
            wrapper: MessagesWrapper
        });
        expect(screen.getByText("59,99€")).toBeTruthy();
        expect(screen.queryByText(/%$/)).toBeNull();
    });

    it("says when a game that is not out yet is coming", () => {
        render(<LinkCard preview={game({ comingSoon: true, releaseDate: "Q1 2027" })} />, {
            wrapper: MessagesWrapper
        });
        expect(screen.getByText("Coming Q1 2027")).toBeTruthy();
        render(<LinkCard preview={game({ comingSoon: true, releaseDate: "" })} />, {
            wrapper: MessagesWrapper
        });
        expect(screen.getByText("Coming soon")).toBeTruthy();
    });
});
