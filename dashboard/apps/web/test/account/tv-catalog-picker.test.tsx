// @vitest-environment jsdom
/**
 * The themes and add-ons picker on /account/tv, with the real gallery and only
 * the words the account and TV layouts hand it: every label reads as words in
 * both languages, the gallery does not repeat the picker's title or tell the
 * reader to pick on the TV, and a catalog that cannot be fetched says so and
 * offers to try again instead of claiming the release has none.
 */

import type { ReactElement } from "react";
import type { Locale } from "@polaris/core";
import { webCatalogs } from "../../messages";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TvRow } from "@/lib/tv/update-requests";
import type { TvCatalogEntry } from "@/lib/tv/catalog-picks";
import { I18nProvider } from "@/components/i18n/i18n-provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/components/i18n/messages", () => ({ Messages: () => null }));

const { default: AccountLayout } = await import("@/app/(app)/account/layout");
const { default: TvLayout } = await import("@/app/(app)/account/tv/layout");
const { TvCatalogPicker } = await import("@/app/(app)/account/tv/tv-catalog-picker");

type Namespaces = Parameters<typeof webCatalogs.pick>[1];

function namespacesOf(layout: (props: { children: null }) => unknown): Namespaces {
    return (layout({ children: null }) as ReactElement<{ namespaces: Namespaces }>).props
        .namespaces;
}

const LOADED = [...namespacesOf(AccountLayout), ...namespacesOf(TvLayout)] as Namespaces;

const ITEMS: TvCatalogEntry[] = [
    {
        id: "aerial",
        kind: "theme",
        name: "Sample aerial",
        description: "Sample description",
        network: false,
        minSdk: 26,
        screenshot: "theme-aerial.jpg"
    },
    {
        id: "weather",
        kind: "addon",
        name: "Sample weather",
        description: "Sample description",
        network: true,
        minSdk: 26,
        screenshot: "addon-weather.jpg"
    }
];

const ROW = {
    id: "0190a000-0000-7000-8000-00000000000a",
    versionCode: 16,
    catalog: { theme: null, addons: null }
} as unknown as TvRow;

function draw(load: () => Promise<TvCatalogEntry[] | null | "unreachable">, locale: Locale) {
    const messages = webCatalogs.pick(locale, LOADED);
    return render(
        <I18nProvider locale={locale} messages={messages}>
            <TvCatalogPicker row={ROW} load={load} onTheme={() => {}} onAddons={() => {}} />
        </I18nProvider>
    );
}

afterEach(cleanup);

describe("the themes and add-ons picker", () => {
    it.each(["en-US", "es-ES"] as const)("reads as words in %s", async (locale) => {
        const { container } = draw(async () => ITEMS, locale);
        fireEvent.click(screen.getByRole("button", { expanded: false }));
        await screen.findByText("Sample aerial");
        const text = container.textContent ?? "";
        expect(text).not.toMatch(/tvCompat\.|account\./);
        const alts = [...container.querySelectorAll("img")].map((img) => img.alt);
        expect(alts.join(" ")).not.toMatch(/tvCompat\./);
        expect(container.querySelector("h2")).toBeNull();
        const tvCompat = webCatalogs.pick(locale, ["tvCompat"]).tvCompat as {
            gallery: { intro: string };
        };
        expect(text).not.toContain(tvCompat.gallery.intro);
    });

    it("says a catalog that cannot be fetched could not be reached, and tries again", async () => {
        const load = vi
            .fn<() => Promise<TvCatalogEntry[] | null | "unreachable">>()
            .mockResolvedValueOnce("unreachable")
            .mockResolvedValueOnce(ITEMS);
        draw(load, "en-US");
        fireEvent.click(screen.getByRole("button", { expanded: false }));
        expect((await screen.findByRole("alert")).textContent).toBe(
            "Could not reach the newest TV release. Try again in a minute."
        );
        expect(screen.queryByText("No themes or add-ons in the newest TV release.")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        await screen.findByText("Sample aerial");
        expect(load).toHaveBeenCalledTimes(2);
    });

    it("sends a pick the TV could not apply again from the status line", () => {
        const onTheme = vi.fn();
        const onAddons = vi.fn();
        const row = {
            ...ROW,
            catalog: {
                theme: { id: "aerial", applied: "failed" },
                addons: { ids: ["weather"], applied: "installed" }
            }
        } as unknown as TvRow;
        render(
            <I18nProvider locale="en-US" messages={webCatalogs.pick("en-US", LOADED)}>
                <TvCatalogPicker
                    row={row}
                    load={async () => ITEMS}
                    onTheme={onTheme}
                    onAddons={onAddons}
                />
            </I18nProvider>
        );
        screen.getByText("The TV could not apply it. Try again.");
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        expect(onTheme).toHaveBeenCalledWith("aerial");
        expect(onAddons).not.toHaveBeenCalled();
    });

    it("offers no retry while nothing failed", () => {
        draw(async () => ITEMS, "en-US");
        expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    });
});
