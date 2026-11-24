// @vitest-environment jsdom

/**
 * The desktop card's way out when an antivirus stops the app: a link to the
 * public guide, in the reader's language, on the page both the dashboard and
 * the public site draw.
 */

import type { ReactNode } from "react";
import { I18nContext } from "../../src/i18n";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DownloadsPage } from "../../src/downloads/account/downloads-page";
import { AntivirusHelpLink } from "../../src/downloads/account/antivirus-help";
import tvEn from "../../../../apps/web/messages/en-US/tvCompat.json" with { type: "json" };
import en from "../../../../apps/web/messages/en-US/account.json" with { type: "json" };
import es from "../../../../apps/web/messages/es-ES/account.json" with { type: "json" };
import componentsEn from "../../../../apps/web/messages/en-US/components.json" with { type: "json" };

afterEach(cleanup);

function inLocale(locale: "en-US" | "es-ES", children: ReactNode) {
    const account = (locale === "en-US" ? en : es) as never;
    return (
        <I18nContext.Provider
            value={{ locale, messages: { account, components: componentsEn as never, tvCompat: tvEn as never } }}
        >
            {children}
        </I18nContext.Provider>
    );
}

describe("AntivirusHelpLink", () => {
    it("opens the English guide in a new tab", () => {
        render(inLocale("en-US", <AntivirusHelpLink />));
        const link = screen.getByRole("link", { name: en.downloads.desktop.antivirus });
        expect(link.getAttribute("href")).toBe("https://fjrg2007.github.io/polaris/en/docs/antivirus/");
        expect(link.getAttribute("target")).toBe("_blank");
        expect(link.getAttribute("rel")).toContain("noreferrer");
    });

    it("opens the Spanish guide for a Spanish reader", () => {
        render(inLocale("es-ES", <AntivirusHelpLink />));
        const link = screen.getByRole("link", { name: es.downloads.desktop.antivirus });
        expect(link.getAttribute("href")).toBe("https://fjrg2007.github.io/polaris/es/docs/antivirus/");
    });
});

describe("DownloadsPage", () => {
    it("offers the antivirus guide on the desktop card", () => {
        const { container } = render(
            inLocale(
                "en-US",
                <DownloadsPage repo="owner/repo" serverUrl={null} extensionFiles={null} deck={null} desktopFiles={null} />
            )
        );
        const card = container.querySelector("#desktop");
        expect(card).toBeTruthy();
        const link = screen.getByRole("link", { name: en.downloads.desktop.antivirus });
        expect(card!.contains(link)).toBe(true);
    });
});
