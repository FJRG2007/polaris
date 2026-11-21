// @vitest-environment jsdom

/**
 * Choosing the satellite imagery: a keyed provider is only kept once a test tile
 * drew with the key, the key is stored through the encrypted integration secret
 * (never in config), going back to the default keeps the key on file, and the
 * dialog says on screen whether the key works.
 */

import { withMessages } from "../setup/i18n";
import { SERVICE_INTEGRATIONS } from "@/lib/integrations/registry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IntegrationCard } from "@/app/(app)/admin/integrations/integrations-view";

const KEY = "fixture-key-0123456789abcdef";
const upserts: Array<{ provider: string; input: Record<string, unknown> }> = [];
let stored: { enabled: boolean; config: Record<string, unknown>; hasSecret: boolean } | null = null;
let storedSecret: string | null = null;
let tile: () => Response = () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/jpeg" } });
const fetched: string[] = [];

vi.mock("@/lib/session", () => ({ requireAdmin: async () => ({ id: "admin" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/setting-store", () => ({ getSetting: async () => null, setSetting: async () => undefined }));
vi.mock("@/lib/i18n/request", async () => {
    const { translatorFor } = await import("@/lib/i18n/translate");
    return { getTranslations: async (namespace: "admin") => translatorFor("en-US", namespace) };
});
vi.mock("@/lib/integration-service", () => ({
    getIntegrationState: async () => (stored ? { provider: "satellite-imagery", updatedAt: null, ...stored } : null),
    getIntegrationSecret: async () => storedSecret,
    upsertIntegration: async (provider: string, input: Record<string, unknown>) => {
        upserts.push({ provider, input });
    }
}));

const { saveSatelliteImageryAction } = await import("@/app/(app)/admin/integrations/actions");
const { dialogFor } = await import("@/app/(app)/admin/integrations/integrations-view");

beforeEach(() => {
    upserts.length = 0;
    fetched.length = 0;
    stored = null;
    storedSecret = null;
    tile = () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/jpeg" } });
    vi.stubGlobal("fetch", async (url: string) => {
        fetched.push(url);
        return tile();
    });
});

afterEach(() => cleanup());

describe("saving the satellite imagery choice", () => {
    it("tests the key with a tile, then keeps it as the encrypted secret", async () => {
        expect(await saveSatelliteImageryAction({ provider: "maptiler", apiKey: `  ${KEY} ` })).toEqual({ tested: true });
        expect(fetched).toEqual([`https://api.maptiler.com/tiles/satellite-v2/1/1/0.jpg?key=${KEY}`]);
        expect(upserts).toEqual([
            {
                provider: "satellite-imagery",
                input: { enabled: true, config: { provider: "maptiler" }, secret: KEY, installedById: "admin" }
            }
        ]);
        expect(JSON.stringify(upserts[0]?.input.config)).not.toContain(KEY);
    });

    it("refuses a key the provider refuses, saying so, and keeps nothing", async () => {
        tile = () => new Response("denied", { status: 401 });
        const result = await saveSatelliteImageryAction({ provider: "esri", apiKey: KEY });
        expect(result.error).toBe("Esri World Imagery refused this key. Check it was copied whole and allows map tiles.");
        expect(fetched[0]).toContain("ibasemaps-api.arcgis.com");
        expect(upserts).toEqual([]);
    });

    it("says when the quota is used up", async () => {
        tile = () => new Response("", { status: 429 });
        const result = await saveSatelliteImageryAction({ provider: "maptiler", apiKey: KEY });
        expect(result.error).toContain("quota is used up");
    });

    it("refuses something that is not a key before asking anyone", async () => {
        const result = await saveSatelliteImageryAction({ provider: "maptiler", apiKey: "not a key" });
        expect(result.error).toBe("That does not look like an API key. Paste it without spaces.");
        expect(await saveSatelliteImageryAction({ provider: "bing", apiKey: KEY })).toHaveProperty("error");
        expect(fetched).toEqual([]);
    });

    it("asks for a key when none is typed or stored", async () => {
        const result = await saveSatelliteImageryAction({ provider: "maptiler", apiKey: "" });
        expect(result.error).toBeTruthy();
        expect(fetched).toEqual([]);
    });

    it("retests the stored key when only the provider is saved again", async () => {
        stored = { enabled: true, config: { provider: "maptiler" }, hasSecret: true };
        storedSecret = KEY;
        expect(await saveSatelliteImageryAction({ provider: "maptiler", apiKey: "" })).toEqual({ tested: true });
        expect(fetched).toHaveLength(1);
        expect(upserts[0]?.input.secret).toBeUndefined();
    });

    it("goes back to the default without forgetting the key", async () => {
        stored = { enabled: true, config: { provider: "esri" }, hasSecret: true };
        expect(await saveSatelliteImageryAction({ provider: "default" })).toEqual({ tested: false });
        expect(upserts[0]?.input).toEqual({ enabled: false, config: { provider: "default" }, installedById: "admin" });
        expect(fetched).toEqual([]);
    });
});

function imageryCard(overrides: Partial<IntegrationCard> = {}): IntegrationCard {
    const entry = SERVICE_INTEGRATIONS.find((candidate) => candidate.slug === "satellite-imagery");
    if (!entry) throw new Error("no satellite imagery entry");
    return {
        slug: entry.slug,
        name: entry.name,
        category: entry.category,
        summary: entry.summary,
        description: entry.description,
        docsUrl: entry.docsUrl,
        setupLinks: entry.setupLinks,
        requiresApiKey: true,
        apiKeyHelp: entry.apiKeyHelp,
        enabled: false,
        hasSecret: false,
        scanDropPoints: true,
        onDetection: "block",
        verifyAccessIp: true,
        deny: [],
        imagery: { provider: "default", envOverride: false, failure: null },
        ...overrides
    };
}

describe("the satellite imagery dialog", () => {
    it("tests a pasted key and says it works", async () => {
        const Dialog = dialogFor(imageryCard());
        if (!Dialog) throw new Error("no dialog");
        render(withMessages(<Dialog card={imageryCard()} onClose={() => undefined} />));
        fireEvent.click(screen.getByRole("radio", { name: "MapTiler" }));
        fireEvent.change(screen.getByPlaceholderText(/paste/i), { target: { value: KEY } });
        fireEvent.click(screen.getByRole("button", { name: "Test and save" }));
        await waitFor(() => expect(screen.getByText("MapTiler drew a test tile. Maps use it from now on.")).toBeTruthy());
    });

    it("flags a malformed key as it is typed and will not save it", () => {
        const Dialog = dialogFor(imageryCard())!;
        render(withMessages(<Dialog card={imageryCard()} onClose={() => undefined} />));
        fireEvent.click(screen.getByRole("radio", { name: "Esri World Imagery" }));
        fireEvent.change(screen.getByPlaceholderText(/paste/i), { target: { value: "has spaces in it" } });
        expect(screen.getByText("That does not look like an API key. Paste it without spaces.")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Test and save" }).hasAttribute("disabled")).toBe(true);
    });

    it("says when maps fell back to the free imagery, and why", () => {
        const card = imageryCard({
            enabled: true,
            hasSecret: true,
            imagery: {
                provider: "maptiler",
                envOverride: false,
                failure: { provider: "maptiler", reason: "refused", at: new Date().toISOString() }
            }
        });
        const Dialog = dialogFor(card)!;
        render(withMessages(<Dialog card={card} onClose={() => undefined} />));
        expect(screen.getByText(/Maps are showing the free imagery: MapTiler refused the key/)).toBeTruthy();
    });
});
