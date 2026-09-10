/**
 * An asleep service is routed as it always is, and the refusal from its stopped
 * container is answered with the page saying it is waking up - not the one saying
 * it is down.
 */

import { describe, expect, it } from "vitest";
import { VACANT_ASLEEP_PATH } from "@polaris/core";
import { renderDynamicConfig, type AppRoute } from "@/lib/deploy/router";

const route = (overrides: Partial<AppRoute> = {}): AppRoute => ({
    id: "d1",
    hostname: "shop.example.com",
    certResolver: "le",
    dialHost: "web",
    dialPort: 3000,
    ...overrides
});

describe("an asleep service at the edge", () => {
    it("answers a refused connection with the waking page", () => {
        const config = renderDynamicConfig([route({ asleep: true })], { vacantAvailable: true });
        expect(config).toContain(`query: "${VACANT_ASLEEP_PATH}"`);
        expect(config).toMatch(/polaris-app-d1:\n[\s\S]*?middlewares: \[polaris-vacant-asleep/);
        // The plain-http router only redirects; it never shows either page.
        expect(config).not.toMatch(/polaris-app-d1-http:[\s\S]*?polaris-vacant-asleep[\s\S]*?polaris-redirect-https/);
    });

    it("keeps an awake service on the page that says it is down", () => {
        const config = renderDynamicConfig([route()], { vacantAvailable: true });
        expect(config).not.toContain(VACANT_ASLEEP_PATH);
        expect(config).toMatch(/polaris-app-d1:\n[\s\S]*?middlewares: \[polaris-vacant-errors/);
    });
});
