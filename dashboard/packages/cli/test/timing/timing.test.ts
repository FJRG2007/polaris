/**
 * PLR_DEBUG=1 says where a command's time went - the keychain read and each
 * request - and never what was read or sent: no token, no query string.
 */

import { run } from "../../src/cli.js";
import { saveConfig } from "../../src/config.js";
import type { Probe } from "../../src/guard.js";
import { timingReport } from "../../src/timing.js";
import { afterEach, describe, expect, it } from "vitest";
import { fakeKeychain, scriptedFetch, testContext } from "../helpers/context.js";

const TOKEN = "plk_TESTONLY.fixture-secret-value-0123456789";
const clean: Probe = { exists: () => false, read: () => null };

afterEach(() => {
    delete process.env.PLR_DEBUG;
    timingReport();
});

async function signedIn() {
    const keychain = fakeKeychain();
    const server = scriptedFetch({
        "GET /api/v1/deploy/services": () =>
            Response.json({ error: "Polaris does not have that." }, { status: 404 })
    });
    const recorded = await testContext({ fetch: server.fetch, run: keychain.run });
    await recorded.context.secrets.save("default", TOKEN);
    await saveConfig(recorded.context.configDir, {
        current: "default",
        profiles: {
            default: {
                url: "https://polaris.example.com",
                account: { id: "u1", name: "Fixture", email: "fixture@example.com" },
                keyId: "k1",
                scopes: ["deploy.read"],
                storage: "keychain",
                signedInAt: "2026-01-01T00:00:00.000Z"
            }
        }
    });
    return recorded;
}

describe("PLR_DEBUG", () => {
    it("names each phase with its time, and nothing that was read or sent", async () => {
        process.env.PLR_DEBUG = "1";
        const { context } = await signedIn();
        await run(["service", "shop/secret-service-name"], context, clean).catch(() => undefined);
        const report = timingReport();
        expect(report).toMatch(/plr: timing: server-install check \d+ ms/);
        expect(report).toMatch(/plr: timing: sign-in read from the keychain \d+ ms/);
        expect(report).toMatch(/plr: timing: GET \/api\/v1\/deploy\/services 404 \d+ ms/);
        expect(report).toMatch(/plr: timing: total \d+ ms since node started/);
        expect(report).not.toContain(TOKEN);
        expect(report).not.toContain("secret-service-name");
    });

    it("records nothing when it is not set", async () => {
        const { context } = await signedIn();
        await run(["service", "shop/web"], context, clean).catch(() => undefined);
        expect(timingReport()).toBe("");
    });
});
