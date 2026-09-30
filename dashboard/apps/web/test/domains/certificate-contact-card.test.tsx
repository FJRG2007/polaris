/**
 * The certificate contact card: what it says about the edge, in both languages.
 *
 * It replaced a notice that told the operator to edit `.env` and restart the edge
 * by hand. What is pinned is that each state says what is wrong in terms the reader
 * can see and offers the button or the page that fixes it - and that no state ever
 * names a file, a variable or a command.
 */

import type { Locale } from "@polaris/core";
import { withMessages } from "../setup/i18n";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AcmeContactStatus } from "@/lib/tls/acme-edge";

let status: AcmeContactStatus | null = null;

vi.mock("../../src/app/(app)/admin/domains/actions", () => ({}));
vi.mock("@/components/use-live-resource", () => ({
    useLiveResource: () => ({
        data: status,
        loading: status === null,
        error: null,
        stale: null,
        refreshing: false,
        updatedAt: status ? 1 : null,
        kept: false,
        refresh: () => undefined,
        replace: () => undefined
    })
}));

const { CertificateContactCard } = await import("../../src/app/(app)/admin/domains/certificate-contact-card");

function render(next: AcmeContactStatus | null, locale: Locale = "en-US"): string {
    status = next;
    return renderToStaticMarkup(withMessages(<CertificateContactCard />, locale));
}

const BASE: AcmeContactStatus = { email: "", source: "none", edge: "current", canRestart: true };

/** Nothing on the card may send the reader to a terminal or a file. */
function expectNoTerminal(markup: string): void {
    for (const word of [".env", "POLARIS_", "docker", "terminal", "ssh"]) expect(markup).not.toContain(word);
}

describe("the certificate contact card", () => {
    it("paints its heading before the edge has been asked", () => {
        const markup = render(null);
        expect(markup).toContain("Certificate contact");
        expect(markup).toContain('id="certificate-contact"');
    });

    it("says no address is needed when there is none", () => {
        for (const [locale, words] of [
            ["en-US", "certificates are requested without one"],
            ["es-ES", "los certificados se piden sin ella"]
        ] as const) {
            const markup = render(BASE, locale);
            expect(markup).toContain(words);
            expectNoTerminal(markup);
        }
    });

    it("offers the restart when the edge has not read a saved address", () => {
        for (const [locale, words, button] of [
            ["en-US", "keeps the previous address until it restarts", "Restart the edge"],
            ["es-ES", "mantiene la dirección anterior hasta que se reinicie", "Reiniciar el borde"]
        ] as const) {
            const markup = render({ ...BASE, email: "me@mail.co", source: "setting", edge: "pending" }, locale);
            expect(markup).toContain(words);
            expect(markup).toContain(button);
            expectNoTerminal(markup);
        }
    });

    it("sends an edge that predates the setting to the update", () => {
        for (const [locale, words] of [
            ["en-US", "Install the latest update"],
            ["es-ES", "Instala la última actualización"]
        ] as const) {
            const markup = render({ ...BASE, email: "ops@corp.io", source: "install", edge: "outdated" }, locale);
            expect(markup).toContain(words);
            expect(markup).toContain('href="/admin/settings"');
            expectNoTerminal(markup);
        }
    });

    it("says when a change waits for the machine to restart, with no button it cannot honour", () => {
        for (const [locale, words] of [
            ["en-US", "the next time the machine restarts"],
            ["es-ES", "la próxima vez que se reinicie la máquina"]
        ] as const) {
            const markup = render({ ...BASE, email: "me@mail.co", source: "setting", edge: "unknown", canRestart: false }, locale);
            expect(markup).toContain(words);
            expect(markup).not.toContain("Restart the edge");
            expectNoTerminal(markup);
        }
    });

    it("names where an address came from when the installer chose it", () => {
        const markup = render({ ...BASE, email: "ops@corp.io", source: "install" });
        expect(markup).toContain("Taken from the installation");
        expect(markup).toContain('value="ops@corp.io"');
    });
});
