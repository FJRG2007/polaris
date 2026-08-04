/**
 * The manifest GitHub reads to create this instance's App.
 *
 * This is the regression the change exists for: the manifest was built entirely
 * from the browser's origin, so an administrator on a LAN name - or on the bind
 * address, `http://0.0.0.0:3000` - sent GitHub a webhook it cannot resolve. GitHub
 * validates that URL while reading the manifest and refuses the whole registration
 * ("Hook url is not supported because it isn't reachable over the public Internet"),
 * so the one-click button created nothing at all.
 *
 * The browser-facing URLs must stay on that same origin regardless: the redirect
 * back carries the CSRF state cookie, which only exists on the host the flow started
 * on.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/integration-service", () => ({
    getIntegrationSecret: async () => null,
    getIntegrationState: async () => null,
    upsertIntegration: async () => undefined
}));

const { buildAppManifest } = await import("@/lib/github-service");

const LAN = "http://0.0.0.0:3000";
const PUBLIC = "https://polaris.example.com";

describe("buildAppManifest", () => {
    it("declares no webhook when nothing outside can reach this instance", () => {
        const manifest = buildAppManifest({ name: "Polaris abcd", origin: LAN, publicUrl: null });

        expect(manifest.hook_attributes).toBeUndefined();
        // Events with no hook to deliver them is the other half GitHub rejects.
        expect(manifest.default_events).toBeUndefined();
    });

    it("points the webhook at the public address, not the browser's", () => {
        const manifest = buildAppManifest({ name: "Polaris abcd", origin: LAN, publicUrl: PUBLIC });

        expect(manifest.hook_attributes).toEqual({
            url: `${PUBLIC}/api/deploy/github/webhook`,
            active: true
        });
        expect(manifest.default_events).toContain("push");
    });

    it("returns the browser to the origin it started on, where its state cookie is", () => {
        const manifest = buildAppManifest({ name: "Polaris abcd", origin: LAN, publicUrl: PUBLIC });

        expect(manifest.redirect_url).toBe(`${LAN}/api/integrations/github/callback`);
        expect(manifest.setup_url).toBe(`${LAN}/api/integrations/github/callback`);
    });

    it("registers the account-linking callback on both addresses when they differ", () => {
        expect(buildAppManifest({ name: "Polaris abcd", origin: LAN, publicUrl: PUBLIC }).callback_urls).toEqual([
            `${LAN}/api/integrations/github/link/callback`,
            `${PUBLIC}/api/integrations/github/link/callback`
        ]);
        expect(buildAppManifest({ name: "Polaris abcd", origin: PUBLIC, publicUrl: PUBLIC }).callback_urls).toEqual([
            `${PUBLIC}/api/integrations/github/link/callback`
        ]);
    });
});
