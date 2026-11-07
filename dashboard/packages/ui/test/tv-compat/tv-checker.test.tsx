// @vitest-environment jsdom

/**
 * "Does it work on my TV?" as it draws: the tiers, a model found by its number
 * typed without dashes, and a TV no list names answered from its About screen
 * instead of a dead end - with the install offered only where there is one.
 */

import type { ReactNode } from "react";
import { I18nContext } from "../../src/i18n";
import { TV_MODELS } from "@polaris/core/tv-compat";
import { afterEach, describe, expect, it } from "vitest";
import { TvChecker, TvPrivacyGuide } from "../../src/tv-compat/tv-checker";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import en from "../../../../apps/web/messages/en-US/tvCompat.json" with { type: "json" };
import es from "../../../../apps/web/messages/es-ES/tvCompat.json" with { type: "json" };

afterEach(cleanup);

function inLocale(locale: "en-US" | "es-ES", children: ReactNode) {
    const tvCompat = (locale === "en-US" ? en : es) as never;
    return (
        <I18nContext.Provider value={{ locale, messages: { tvCompat } }}>
            {children}
        </I18nContext.Provider>
    );
}

const install = (tier: string) =>
    tier === "network" ? null : <button type="button">Install here</button>;

describe("TvChecker", () => {
    it("explains the three tiers and that a model need not be listed", () => {
        render(inLocale("en-US", <TvChecker />));
        expect(screen.getByRole("heading", { name: en.title })).toBeTruthy();
        expect(screen.getByText(en.intro)).toBeTruthy();
        for (const tier of ["full", "app", "network"] as const)
            expect(screen.getAllByText(en.tiers[tier].name).length).toBeGreaterThan(0);
    });

    it("finds a model by its number typed without dashes", () => {
        render(inLocale("en-US", <TvChecker action={install} />));
        fireEvent.change(screen.getByLabelText(en.search.label), {
            target: { value: "kd75xe8596" }
        });
        const results = screen.getByRole("region", { name: en.search.results });
        expect(within(results).getByText(/KD-75XE8596/)).toBeTruthy();
        expect(within(results).getAllByRole("button", { name: "Install here" }).length).toBe(1);
        expect(within(results).getByText(/upstream launcher/)).toBeTruthy();
    });

    it("answers an unlisted TV by its platform and version", () => {
        render(inLocale("en-US", <TvChecker action={install} />));
        fireEvent.change(screen.getByLabelText(en.search.label), {
            target: { value: "zzqx9000" }
        });
        expect(screen.getByText("0 models")).toBeTruthy();
        const missing = screen.getByRole("region", { name: en.missing.title });
        expect(within(missing).getByText(en.tiers.full.summary)).toBeTruthy();
        expect(within(missing).getByRole("button", { name: "Install here" })).toBeTruthy();
        fireEvent.change(within(missing).getByLabelText(en.missing.version), {
            target: { value: "7.1" }
        });
        expect(within(missing).getByText(en.tiers.network.summary)).toBeTruthy();
        expect(within(missing).getByText(en.quirks["android-too-old"])).toBeTruthy();
        expect(within(missing).queryByRole("button", { name: "Install here" })).toBeNull();
    });

    it("narrows to a brand from its chip", () => {
        render(inLocale("en-US", <TvChecker heading={false} />));
        const chips = screen.getByRole("group", { name: en.search.brands });
        fireEvent.click(within(chips).getByRole("button", { name: /^TCL/ }));
        expect(
            within(chips).getByRole("button", { name: /^TCL/ }).getAttribute("aria-pressed")
        ).toBe("true");
        const tcl = TV_MODELS.filter((model) => model.brand === "TCL").length;
        expect(screen.getByText(`${tcl} models`)).toBeTruthy();
    });

    it("draws in Spanish from the Spanish catalog", () => {
        render(inLocale("es-ES", <TvChecker />));
        expect(screen.getByRole("heading", { name: es.title })).toBeTruthy();
    });
});

describe("TvPrivacyGuide", () => {
    it("lists each brand with its menu paths and a source", () => {
        render(inLocale("en-US", <TvPrivacyGuide />));
        expect(screen.getByRole("heading", { name: "Roku" })).toBeTruthy();
        expect(screen.getAllByText(/Settings > Privacy/).length).toBeGreaterThan(0);
        expect(screen.getAllByRole("link", { name: en.privacy.source }).length).toBeGreaterThan(5);
    });
});
