/**
 * The Settings screen, drawn in Spanish and in English.
 *
 * The update card's rows and selects used to be module-level constants, which
 * freeze in whichever language loaded them first; the transfer card counts rows
 * and secrets, and its confirmation word stays "replace" in every language
 * because that is what the server compares.
 */

import { withMessages } from "../../setup/i18n";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/app/(app)/admin/settings/actions", () => ({
    checkUpdatesAction: async () => ({}),
    saveAutoUpdateAction: async () => ({}),
    saveLegalContactAction: async () => ({}),
    saveUpdateSourceAction: async () => ({}),
    triggerHostUpdateAction: async () => ({ status: "started" }),
    updateReportAction: async () => ({ url: "" })
}));
vi.mock("@/app/(app)/admin/settings/transfer-actions", () => ({
    applyImportAction: async () => ({}),
    exportInstanceAction: async () => ({}),
    previewImportAction: async () => ({})
}));
vi.mock("@/app/(app)/admin/domains/actions", () => ({ removeAddressAction: async () => ({}) }));
vi.mock("@/lib/use-password-safety", () => ({ usePasswordSafety: () => null }));

const { SettingsView } = await import("@/app/(app)/admin/settings/settings-view");
const { TransferCard } = await import("@/app/(app)/admin/settings/transfer-card");

function settings(locale: "en-US" | "es-ES") {
    return renderToStaticMarkup(
        withMessages(
            <SettingsView
                initialPolicy={{ mode: "daily", at: "04:00" }}
                initialSource="image"
                initialContact=""
                publicPages={{
                    home: "https://polaris.example.com/about",
                    privacy: "https://polaris.example.com/legal/privacy",
                    terms: "https://polaris.example.com/legal/terms"
                }}
                deployment={{ hostname: "polaris", repo: "example/polaris", branch: "main", autoUpdate: true }}
            />,
            locale
        )
    );
}

describe("the settings screen in Spanish", () => {
    const markup = settings("es-ES");

    it("labels the update card and its choices in Spanish", () => {
        expect(markup).toContain("Buscar actualizaciones");
        expect(markup).toContain("Versión en uso");
        expect(markup).toContain("Se instala a las 04:00 siguientes a que aparezca una compilación.");
        expect(markup).toContain("Descarga la compilación que GitHub ya ha hecho.");
        expect(markup).not.toContain("Check for updates");
    });

    it("draws the deployment facts and public pages in Spanish", () => {
        expect(markup).toContain("Rama de versión");
        expect(markup).toContain("Privacidad");
        expect(markup).toContain("Guardar");
        expect(markup).not.toContain("Release branch");
    });
});

describe("the settings screen in English", () => {
    it("reads as it did before it was translated", () => {
        const markup = settings("en-US");
        expect(markup).toContain("Check for updates");
        expect(markup).toContain(
            "Installs at the first 04:00 after a build appears. If Polaris is off then, it installs when it comes back."
        );
        expect(markup).toContain("Release branch");
    });
});

describe("the transfer card in Spanish", () => {
    const markup = renderToStaticMarkup(withMessages(<TransferCard identity={["ada@example.com"]} />, "es-ES"));

    it("explains the export and import in Spanish", () => {
        expect(markup).toContain("Mover a otra máquina");
        expect(markup).toContain("Repite la frase");
        expect(markup).toContain("En una instalación nueva: importa una exportación.");
        expect(markup).not.toContain("Move to another machine");
    });
});
