import { describe, expect, it, vi } from "vitest";
import { openInPage, setRouterListening, type RoutablePage } from "@/main/page-router";
import { CHANNELS } from "@/shared/bridge";

const ORIGIN = "https://polaris.example.test";

function page(id: number, url = `${ORIGIN}/chat/c/room`) {
    const navigations: ((details: { isMainFrame?: boolean; isSameDocument?: boolean; }) => void)[] = [];
    const made = {
        id,
        isDestroyed: () => false,
        getURL: () => url,
        send: vi.fn(),
        loadURL: vi.fn(() => Promise.resolve()),
        once: vi.fn(),
        on: vi.fn((_event: string, listener: (details: { isMainFrame?: boolean; isSameDocument?: boolean; }) => void) => navigations.push(listener))
    };
    return { made: made as RoutablePage & typeof made, navigate: (details: { isMainFrame?: boolean; isSameDocument?: boolean; }) => navigations.forEach((listener) => listener(details)) };
}

describe("openInPage", () => {
    it("loads the address over a page whose router never said it listens", () => {
        const { made } = page(1);
        expect(openInPage(made, `${ORIGIN}/game-servers`, ORIGIN)).toBe("loaded");
        expect(made.loadURL).toHaveBeenCalledWith(`${ORIGIN}/game-servers`);
        expect(made.send).not.toHaveBeenCalled();
    });

    it("hands the path to a listening page instead of reloading it, so its call stays up", () => {
        const { made } = page(2);
        setRouterListening(made, true);
        expect(openInPage(made, `${ORIGIN}/game-servers/abc?tab=1#x`, ORIGIN)).toBe("routed");
        expect(made.send).toHaveBeenCalledWith(CHANNELS.navigate, "/game-servers/abc?tab=1#x");
        expect(made.loadURL).not.toHaveBeenCalled();
    });

    it("forgets a page once it is replaced by a full load, but not on a same-document step", () => {
        const { made, navigate } = page(3);
        setRouterListening(made, true);
        navigate({ isMainFrame: true, isSameDocument: true });
        expect(openInPage(made, `${ORIGIN}/home`, ORIGIN)).toBe("routed");
        navigate({ isMainFrame: true, isSameDocument: false });
        expect(openInPage(made, `${ORIGIN}/home`, ORIGIN)).toBe("loaded");
    });

    it("loads when the page is not on this Polaris, or the target is another origin", () => {
        const { made } = page(4, "https://other.example.test/home");
        setRouterListening(made, true);
        expect(openInPage(made, `${ORIGIN}/home`, ORIGIN)).toBe("loaded");
        const { made: on } = page(5);
        setRouterListening(on, true);
        expect(openInPage(on, "https://other.example.test/home", ORIGIN)).toBe("loaded");
    });

    it("never hands a path to a page on the Polaris that is not one of its screens", () => {
        const { made } = page(7, `${ORIGIN}/api/preview/session`);
        setRouterListening(made, true);
        expect(openInPage(made, `${ORIGIN}/home`, ORIGIN)).toBe("loaded");
        expect(made.send).not.toHaveBeenCalled();
    });

    it("stops routing once the page says it no longer listens", () => {
        const { made } = page(6);
        setRouterListening(made, true);
        setRouterListening(made, false);
        expect(openInPage(made, `${ORIGIN}/home`, ORIGIN)).toBe("loaded");
    });
});
