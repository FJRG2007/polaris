/**
 * An intake form's public link runs the same gates as every other public link:
 * open, usable (expiry, cap on submissions), address rules, then the password.
 * A form with none of them set, as every existing one is, opens for anyone.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/config", () => ({
    loadEnv: () => ({ POLARIS_AUTH_SECRET: "one-secret-for-every-signature-here" })
}));

const findUnique = vi.fn();
vi.mock("@polaris/db", () => ({ prisma: { taskForm: { findUnique } } }));

let ip: string | undefined = "198.51.100.7";
vi.mock("@/lib/request-context", () => ({ clientIp: async () => ip }));
let flagged = false;
vi.mock("@/lib/dymo-service", () => ({ dymoIpAllowed: async () => ({ allowed: !flagged }) }));
let inRegion = true;
vi.mock("@/lib/geo-service", () => ({ geoAllowedForIp: async () => inRegion }));

let cookie: string | undefined;
vi.mock("next/headers", () => ({
    cookies: async () => ({ get: () => (cookie === undefined ? undefined : { value: cookie }) })
}));

const gate = await import("@/lib/tasks/form-access");

const FORM = "01a081bf-94a6-76c1-9907-ab70aa5f6471";
const HASH = "scrypt$salt-one$hash-one";
const row = (overrides: Record<string, unknown> = {}) => ({
    id: FORM,
    enabled: true,
    passwordHash: null,
    expiresAt: null,
    maxSubmissions: null,
    allowedCidrs: "[]",
    allowedCountries: "[]",
    allowedContinents: "[]",
    _count: { submissions: 0 },
    ...overrides
});

describe("an intake form's public link", () => {
    it("opens with no limits, as every existing form has", async () => {
        findUnique.mockResolvedValueOnce(row());
        expect(await gate.gateTaskForm("token")).toEqual({ ok: true, formId: FORM });
    });

    it("answers not_found for an unknown token and for a closed form alike", async () => {
        findUnique.mockResolvedValueOnce(null);
        expect(await gate.gateTaskForm("token")).toEqual({ ok: false, reason: "not_found" });
        findUnique.mockResolvedValueOnce(row({ enabled: false }));
        expect(await gate.gateTaskForm("token")).toEqual({ ok: false, reason: "not_found" });
    });

    it("stops once it has expired", async () => {
        findUnique.mockResolvedValueOnce(row({ expiresAt: new Date(Date.now() - 1000) }));
        expect(await gate.gateTaskForm("token")).toEqual({ ok: false, reason: "expired" });
    });

    it("stops once it has received as many responses as it allows", async () => {
        findUnique.mockResolvedValueOnce(row({ maxSubmissions: 2, _count: { submissions: 2 } }));
        expect(await gate.gateTaskForm("token")).toEqual({ ok: false, reason: "exhausted" });
        findUnique.mockResolvedValueOnce(row({ maxSubmissions: 2, _count: { submissions: 1 } }));
        expect(await gate.gateTaskForm("token")).toEqual({ ok: true, formId: FORM });
    });

    it("refuses an address outside its list", async () => {
        ip = "203.0.113.9";
        findUnique.mockResolvedValueOnce(row({ allowedCidrs: '["198.51.100.0/24"]' }));
        expect(await gate.gateTaskForm("token")).toEqual({ ok: false, reason: "ip_not_allowed" });
        ip = "198.51.100.7";
    });

    it("refuses a visitor outside its countries", async () => {
        inRegion = false;
        findUnique.mockResolvedValueOnce(row({ allowedCountries: '["ES"]' }));
        expect(await gate.gateTaskForm("token")).toEqual({
            ok: false,
            reason: "country_not_allowed"
        });
        inRegion = true;
    });

    it("refuses an address the fraud check flags", async () => {
        flagged = true;
        findUnique.mockResolvedValueOnce(row());
        expect(await gate.gateTaskForm("token")).toEqual({ ok: false, reason: "ip_flagged" });
        flagged = false;
    });

    it("asks for the password until it is solved, in its own scope", async () => {
        cookie = undefined;
        findUnique.mockResolvedValueOnce(row({ passwordHash: HASH }));
        expect(await gate.gateTaskForm("token")).toEqual({
            ok: false,
            reason: "password_required"
        });

        cookie = gate.signFormUnlock(FORM, HASH);
        findUnique.mockResolvedValueOnce(row({ passwordHash: HASH }));
        expect(await gate.gateTaskForm("token")).toEqual({ ok: true, formId: FORM });

        const { signUnlock } = await import("@/lib/link-guards");
        cookie = signUnlock(
            "task",
            FORM,
            { passwordHash: HASH },
            "one-secret-for-every-signature-here"
        );
        findUnique.mockResolvedValueOnce(row({ passwordHash: HASH }));
        expect(await gate.gateTaskForm("token")).toEqual({
            ok: false,
            reason: "password_required"
        });
        cookie = undefined;
    });
});
