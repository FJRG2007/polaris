// @vitest-environment jsdom

/**
 * The shell hands the provider a new offer object on every refresh. The queue
 * behind it - its cache and the device engines it loaded - must survive that,
 * or every refresh makes the next translation start from nothing.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, refresh() {} }) }));
vi.mock("@/components/i18n/i18n-provider", () => ({ useLocale: () => "es-ES" }));

import {
    TextTranslationProvider,
    useTextTranslator,
    type TextTranslator
} from "@/components/text-translation/provider";

const seen: { current: TextTranslator | null } = { current: null };

function Reader() {
    seen.current = useTextTranslator();
    return null;
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("the translation queue", () => {
    it("keeps its cache when the offer comes back as a new object saying the same", async () => {
        const fetcher = vi.fn(async (_input: string, init?: RequestInit) =>
            init?.method === "POST"
                ? Response.json({ texts: ["hello"], detected: "es" })
                : Response.json({ order: [], engines: null, browser: false, local: false })
        );
        vi.stubGlobal("fetch", fetcher);
        const offer = () => ({ appId: "translate", endpoint: "/api/translate", page: "/translate" });

        const view = render(
            <TextTranslationProvider offer={offer()}>
                <Reader />
            </TextTranslationProvider>
        );
        expect(await seen.current?.translate("hola", "en")).toEqual({
            kind: "translated",
            text: "hello",
            detected: "es"
        });

        view.rerender(
            <TextTranslationProvider offer={offer()}>
                <Reader />
            </TextTranslationProvider>
        );
        await seen.current?.translate("hola", "en");

        const posts = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
        expect(posts).toHaveLength(1);
    });
});
