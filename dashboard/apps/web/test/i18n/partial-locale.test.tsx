// @vitest-environment jsdom

/**
 * A language added with only two messages translated, drawn on a real screen.
 *
 * German is registered here in memory - no catalog folder, no registry entry -
 * with the language card's title and the picker's search box. What a German
 * reader must see is those two in German, every other word on the screen in
 * English, and never a key: the server hands the browser each namespace filled
 * in from the source, so the client has words for everything it draws.
 */

import enUS from "../../messages/en-US";
import esES from "../../messages/es-ES";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/i18n/i18n-provider";
import { defineCatalogs, flattenCatalog, type Catalog, type Locale } from "@polaris/core";

vi.mock("next/navigation", () => ({
    usePathname: () => "/account/preferences",
    useRouter: () => ({ push: () => undefined, refresh: () => undefined })
}));

const { LanguageCard } = await import("@/app/(app)/account/preferences/language-card");

const GERMAN = "de-DE" as Locale;

const catalogs = defineCatalogs({
    "en-US": enUS,
    "es-ES": esES,
    [GERMAN]: {
        account: { language: { title: "Sprache" } },
        common: { languagePicker: { search: "Sprachen suchen" } }
    }
} as never);

describe("a partial locale on a screen", () => {
    const messages = catalogs.pick(GERMAN, catalogs.namespaces);

    it("reaches the browser with every key the source has", () => {
        for (const namespace of catalogs.namespaces) {
            const source = flattenCatalog(enUS[namespace as keyof typeof enUS] as Catalog);
            const given = flattenCatalog(messages[namespace]!);
            expect([...given.keys()].sort(), namespace).toEqual([...source.keys()].sort());
        }
    });

    it("draws its own words in German, the rest in English, and no key", () => {
        const markup = renderToStaticMarkup(
            <I18nProvider locale={GERMAN} messages={messages}>
                <LanguageCard current="en-US" save={async () => ({})} />
            </I18nProvider>
        );
        expect(markup).toContain("Sprache");
        expect(markup).toContain(enUS.account.language.hint);
        expect(markup).not.toContain(enUS.account.language.title);
        expect(markup).not.toMatch(/\b(account|common)\.[a-z]+\.[a-zA-Z]+/);
        expect(markup).not.toContain("language.hint");
    });

    it("translates a server-side message the same way", () => {
        expect(catalogs.translate(GERMAN, "account.language.title" as never)).toBe("Sprache");
        expect(catalogs.translate(GERMAN, "account.language.hint" as never)).toBe(
            enUS.account.language.hint
        );
    });
});
