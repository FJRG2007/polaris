/**
 * The consent screen's error card, for the two reasons added alongside
 * ChatGPT's metadata-document client: its document could not be read
 * (`clientDetails`) versus one that was read and refused (`clientRefused`).
 * Pinned so the rendered sentence a person actually sees is checked, not only
 * which i18n key the logic picked (asserted in flow.test.ts).
 */

import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/session", () => ({
    guardedUser: async () => ({ id: "user-1", isAdmin: false, viewingAs: null }),
    resolveSession: async () => ({ id: "user-1" }),
    requireUser: async () => ({ id: "user-1" })
}));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/mcp/oauth/origin", () => ({
    currentOrigin: async () => "https://polaris.example.test"
}));
vi.mock("@/lib/mcp/oauth/scopes", () => ({ mcpScopes: async () => [] }));
// Pulled in by consent-view.tsx, never reached on the unsafe branch this test
// exercises, but imported unconditionally - and it drags in audit-service.ts,
// which needs a configured database and secrets this test has none of.
vi.mock("@/app/oauth/authorize/actions", () => ({ answerAuthorizationAction: vi.fn() }));
const reason = vi.hoisted(() => ({
    current: "clientDetails" as "clientDetails" | "clientRefused"
}));
vi.mock("@/lib/mcp/oauth/authorize", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/mcp/oauth/authorize")>()),
    checkAuthorizationRequest: async () => ({ kind: "unsafe", reason: reason.current })
}));
const locale = vi.hoisted(() => ({ current: "en-US" as "en-US" | "es-ES" }));
vi.mock("@/lib/i18n/request", async () => {
    const { translatorFor } = await import("@/lib/i18n/translate");
    return {
        getTranslations: async (namespace: "mcp") => translatorFor(locale.current, namespace)
    };
});

const { default: AuthorizePage } = await import("@/app/oauth/authorize/page");

/** AuthorizePage resolves to `<ConsentError reason={...} />` on an unsafe
 *  request; ConsentError is itself async, so it is resolved by hand before
 *  handing static, synchronous JSX to the client renderer. */
async function renderConsentError(): Promise<string> {
    const page = await AuthorizePage({ searchParams: Promise.resolve({ client_id: "x" }) });
    const element = page as ReactElement<{ reason: string }>;
    const inner = await (element.type as (props: { reason: string }) => Promise<ReactElement>)(
        element.props
    );
    return renderToStaticMarkup(inner);
}

describe("the consent error card", () => {
    it("tells an unreadable app document apart from one that was read and refused", async () => {
        reason.current = "clientDetails";
        const unreadable = await renderConsentError();
        expect(unreadable).toContain("could not read the details this app publishes");
        expect(unreadable).toContain("Try connecting again from the app in a few minutes");

        reason.current = "clientRefused";
        const refused = await renderConsentError();
        expect(refused).toContain("does not accept the details this app publishes");
        expect(refused).toContain("Trying again will not change this");

        expect(unreadable).not.toBe(refused);
    });

    it("reads in Spanish", async () => {
        locale.current = "es-ES";
        reason.current = "clientDetails";
        const html = await renderConsentError();
        locale.current = "en-US";
        expect(html).toContain("Polaris no ha podido leer los datos que esta app publica");
    });
});
