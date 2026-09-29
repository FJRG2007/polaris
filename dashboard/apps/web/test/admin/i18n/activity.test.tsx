/**
 * The audit trail's integrity line and the agent catalogue card, drawn in both
 * languages.
 *
 * The integrity line is one sentence put together from a count, an optional
 * clause and a reason; English has to read exactly as it did before the move,
 * and Spanish has to read as a sentence rather than as English with the words
 * swapped.
 */

import { withMessages } from "../../setup/i18n";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

let status: unknown = null;

vi.mock("@/app/(app)/admin/activity/actions", () => ({ verifyAuditChainAction: async () => ({}) }));
vi.mock("@/app/(app)/admin/agents/actions", () => ({
    refreshModelCatalogAction: async () => ({}),
    setInstanceKeySharingAction: async () => ({}),
    setSharedWorkspaceAction: async () => ({})
}));
vi.mock("@/components/use-live-resource", () => ({
    useLiveResource: () => ({ data: status, loading: false, refresh: () => undefined })
}));

const { AuditIntegrity } = await import("@/app/(app)/admin/activity/audit-integrity");
const { CatalogCard } = await import("@/app/(app)/admin/agents/catalog-card");

const SEALED = {
    sealed: 1200,
    pending: 3,
    head: { seq: 1200, hash: "abcdef0123456789abcdef" },
    lastVerification: null
};

describe("audit integrity", () => {
    it("reads as it always did in English", () => {
        status = SEALED;
        const html = renderToStaticMarkup(withMessages(<AuditIntegrity />));

        expect(html).toContain("1200 entries sealed, 3 waiting to be. ");
        expect(html).toContain("Not checked yet.");
        expect(html).toContain("Head #1200 abcdef0123456789");
    });

    it("reads in Spanish", () => {
        status = SEALED;
        const html = renderToStaticMarkup(withMessages(<AuditIntegrity />, "es-ES"));

        expect(html).toContain("1200 entradas selladas, 3 pendientes de sellar.");
        expect(html).toContain("Aún sin comprobar.");
        expect(html).toContain("Comprobar ahora");
        expect(html).not.toContain("entries sealed");
    });

    it("names a broken entry in Spanish", () => {
        status = { ...SEALED, lastVerification: { ok: false, at: "2026-09-01T10:00:00.000Z", broken: { reason: "altered", seq: 42 } } };
        const html = renderToStaticMarkup(withMessages(<AuditIntegrity />, "es-ES"));

        expect(html).toContain("Una entrada se cambió después de sellarse en la entrada 42.");
    });
});

describe("model catalog", () => {
    it("counts models in both languages", () => {
        expect(renderToStaticMarkup(withMessages(<CatalogCard models={1} refreshedAt={null} />))).toContain(
            "1 model across the providers Polaris supports."
        );
        const spanish = renderToStaticMarkup(withMessages(<CatalogCard models={340} refreshedAt={null} />, "es-ES"));
        expect(spanish).toContain("340 modelos de los proveedores que admite Polaris.");
        expect(spanish).toContain("Catálogo de modelos");
    });
});
