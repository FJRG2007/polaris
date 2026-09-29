// @vitest-environment jsdom

/**
 * The integrations marketplace, drawn in Spanish.
 *
 * The grid is asserted on a sentence with values in the middle (the count), and
 * the Cloudflare dialog on the parts built from lists: the token scopes and the
 * capability rows, which used to be module constants frozen in English. The
 * same dialog in English is checked word for word against what it always said.
 */

import { withMessages } from "../../setup/i18n";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SERVICE_INTEGRATIONS } from "@/lib/integrations/registry";
import type { IntegrationCard } from "@/app/(app)/admin/integrations/integrations-view";

// The dialogs call the page's server actions, which reach the database on import.
vi.mock("@/app/(app)/admin/integrations/actions", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const { dialogFor, IntegrationsView } = await import("@/app/(app)/admin/integrations/integrations-view");

afterEach(() => cleanup());

function card(slug: string, overrides: Partial<IntegrationCard> = {}): IntegrationCard {
    const entry = SERVICE_INTEGRATIONS.find((candidate) => candidate.slug === slug);
    if (!entry) throw new Error(`no catalog entry for ${slug}`);
    return {
        slug: entry.slug,
        name: entry.name,
        category: entry.category,
        summary: entry.summary,
        description: entry.description,
        docsUrl: entry.docsUrl,
        requiresApiKey: entry.requiresApiKey,
        enabled: false,
        hasSecret: false,
        scanDropPoints: true,
        onDetection: "block",
        verifyAccessIp: true,
        deny: [],
        ...overrides
    };
}

function cloudflareDialog(locale: "en-US" | "es-ES") {
    const cloudflare = card("cloudflare", { hasSecret: true, enabled: true });
    const Dialog = dialogFor(cloudflare);
    if (!Dialog) throw new Error("no dialog for cloudflare");
    render(withMessages(<Dialog card={cloudflare} onClose={() => undefined} />, locale));
    return document.body.textContent ?? "";
}

describe("integrations in Spanish", () => {
    it("draws the grid in Spanish", () => {
        const cards = SERVICE_INTEGRATIONS.map((entry) => card(entry.slug));
        const markup = renderToStaticMarkup(withMessages(<IntegrationsView cards={cards} />, "es-ES"));
        expect(markup).toContain(`0 de ${cards.length} configuradas`);
        expect(markup).toContain("Buscar integraciones");
        expect(markup).toContain("Documentación");
        expect(markup).not.toContain("Search integrations");
        expect(markup).not.toContain(`of ${cards.length} set up`);
    });

    it("draws the Cloudflare dialog in Spanish", () => {
        const text = cloudflareDialog("es-ES");
        expect(text).toContain("Acceso a la API");
        expect(text).toContain("Registros DNS");
        expect(text).toContain("Sin conectar. Apunta tus zonas a este servidor.");
        expect(text).toContain("Solo túneles");
        expect(text).toContain("Cancelar");
        expect(screen.getByPlaceholderText("Guardado - escribe uno nuevo para sustituirlo")).toBeTruthy();
        expect(text).not.toContain("API access");
        expect(text).not.toContain("Not connected.");
    });

    it("keeps the Cloudflare dialog's English as it was", () => {
        const text = cloudflareDialog("en-US");
        expect(text).toContain("API access");
        expect(text).toContain("Not connected. Points your zones at this server.");
        expect(text).toContain("Tunnels only");
        expect(text).toContain("One token for records and tunnels. The link opens Cloudflare with");
        expect(screen.getByPlaceholderText("Saved - enter a new token to replace it")).toBeTruthy();
    });
});
