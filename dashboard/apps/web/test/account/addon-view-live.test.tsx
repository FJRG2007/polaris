// @vitest-environment jsdom
/**
 * An add-on's open view follows the page: it is told the theme, tokens and
 * locale when it says it is ready, again whenever one of them changes while it
 * is open, and not at all for a change to the root that moves none of them.
 * Settings changed outside it reach it the same way.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { AddonManifest } from "@polaris/core/device-addons";
import type { AddonsBridge } from "@/lib/device-addons-client";

const words = vi.hoisted(() => ({ locale: "en" }));
vi.mock("@/components/i18n/i18n-provider", () => ({
    useLocale: () => words.locale,
    useTranslations: () => (key: string) => key
}));

const { AddonView } = await import("@/app/(app)/account/addons/addons-view");

const manifest = { id: "pedal", name: "Pedal" } as unknown as AddonManifest;
const stored = vi.hoisted(() => ({ values: { knob1: "music" } as Record<string, unknown> }));
const bridge = { viewCall: vi.fn(async () => ({ ok: true, value: null })), settings: vi.fn(async () => ({ ...stored.values })) } as unknown as AddonsBridge;

function hellos(post: ReturnType<typeof vi.fn>): Array<{ locale: string; theme: string; tokens: Record<string, string> }> {
    return post.mock.calls.map((call) => call[0]).filter((message) => message?.type === "hello");
}

async function openView() {
    const view = render(<AddonView bridge={bridge} manifest={manifest} view="view/index.html" />);
    const frame = view.container.querySelector("iframe") as HTMLIFrameElement;
    const target = frame.contentWindow as Window;
    const post = vi.fn();
    target.postMessage = post as unknown as Window["postMessage"];
    window.dispatchEvent(new MessageEvent("message", { data: { type: "ready" }, source: target }));
    return { view, post };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
    cleanup();
    words.locale = "en";
    stored.values = { knob1: "music" };
    document.documentElement.className = "";
    document.documentElement.removeAttribute("style");
});

describe("an open add-on view", () => {
    it("is told the page on ready, and nothing before it", async () => {
        const { post } = await openView();
        expect(hellos(post)).toEqual([{ type: "hello", locale: "en", theme: "dark", tokens: {} }]);
    });

    it("is told again when the theme or a token changes, and only then", async () => {
        const { post } = await openView();
        document.documentElement.classList.add("light");
        await settle();
        expect(hellos(post).at(-1)?.theme).toBe("light");
        document.documentElement.style.setProperty("--primary", "10 80% 50%");
        await settle();
        expect(hellos(post).at(-1)?.tokens).toEqual({ "--primary": "10 80% 50%" });
        const sent = hellos(post).length;
        document.documentElement.classList.add("scroll-locked");
        await settle();
        expect(hellos(post).length).toBe(sent);
    });

    it("is told again when the language changes", async () => {
        const { view, post } = await openView();
        words.locale = "es";
        view.rerender(<AddonView bridge={bridge} manifest={manifest} view="view/index.html" />);
        await settle();
        expect(hellos(post).map((hello) => hello.locale)).toEqual(["en", "es"]);
    });

    it("gets the whole hello again when it reloads and says ready", async () => {
        const { view, post } = await openView();
        const target = (view.container.querySelector("iframe") as HTMLIFrameElement).contentWindow;
        window.dispatchEvent(new MessageEvent("message", { data: { type: "ready" }, source: target }));
        expect(hellos(post).length).toBe(2);
    });

    it("is told the settings on ready, and again only when they changed elsewhere", async () => {
        const { view, post } = await openView();
        const settings = () => post.mock.calls.map((call) => call[0]).filter((message) => message?.type === "settings");
        await settle();
        expect(settings()).toEqual([{ type: "settings", values: { knob1: "music" } }]);
        view.rerender(<AddonView bridge={bridge} manifest={{ ...manifest }} view="view/index.html" />);
        await settle();
        expect(settings().length).toBe(1);
        stored.values = { knob1: "games" };
        view.rerender(<AddonView bridge={bridge} manifest={{ ...manifest }} view="view/index.html" />);
        await settle();
        expect(settings().at(-1)).toEqual({ type: "settings", values: { knob1: "games" } });
    });
});
