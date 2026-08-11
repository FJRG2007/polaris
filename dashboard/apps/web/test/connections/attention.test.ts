/**
 * An integration nobody can get through, and the operator hearing about it.
 *
 * The person who presses Connect cannot fix what refused them, and the operator
 * who can was never told: the refusal happened in somebody else's browser. So a
 * failure is recorded against the integration and raised to whoever may
 * configure it - once an hour, because a broken application refuses everybody
 * who tries and the fortieth alert is the same news as the first.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { rows, alerts, throttle, broken } = vi.hoisted(() => ({
    rows: new Map<string, { provider: string; enabled: boolean; config: Record<string, unknown>; hasSecret: boolean; updatedAt: string | null }>(),
    alerts: [] as { event: string; title: string; body: string }[],
    throttle: { ok: true },
    /** Set when the test wants the write itself to fail. */
    broken: { write: false }
}));

vi.mock("@/lib/integration-service", () => ({
    getIntegrationState: async (provider: string) => rows.get(provider) ?? null,
    upsertIntegration: async (provider: string, input: { config?: Record<string, unknown> }) => {
        if (broken.write) throw new Error("database is gone");
        const existing = rows.get(provider);
        if (!existing) return;
        rows.set(provider, { ...existing, config: input.config ?? existing.config });
    }
}));

vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async () => throttle
}));

vi.mock("@/lib/notifications/operators", () => ({
    notifyOperators: async (alert: { event: string; title: string; body: string }) => {
        alerts.push(alert);
    }
}));

import {
    clearConnectionFailure,
    connectionFailure,
    describeFailure,
    recordConnectionFailure
} from "@/lib/connections/attention";

function install(provider: string, config: Record<string, unknown> = {}): void {
    rows.set(provider, { provider, enabled: true, config, hasSecret: true, updatedAt: null });
}

beforeEach(() => {
    rows.clear();
    alerts.length = 0;
    throttle.ok = true;
    broken.write = false;
});

describe("describeFailure", () => {
    it("repeats what the provider module threw", () => {
        expect(describeFailure(new Error("Epic refused the token request (401): invalid_client"))).toBe(
            "Epic refused the token request (401): invalid_client"
        );
    });

    it("still says something for whatever else was thrown", () => {
        expect(describeFailure("boom")).toMatch(/refused the authorization/);
        expect(describeFailure(new Error("   "))).toMatch(/refused the authorization/);
    });
});

describe("recordConnectionFailure", () => {
    it("records the reason and tells whoever can act on it", async () => {
        install("epic");
        await recordConnectionFailure("epic", "Epic refused the token request (401): invalid_client");

        const held = await connectionFailure("epic");
        expect(held?.reason).toContain("invalid_client");
        expect(Date.parse(held?.at ?? "")).not.toBeNaN();

        expect(alerts).toHaveLength(1);
        expect(alerts[0]?.event).toBe("integration.attention");
        expect(alerts[0]?.title).toContain("Epic Games");
        // The reason travels with it: an alert that only says something failed
        // sends the operator to guess at a console with a dozen switches in it.
        expect(alerts[0]?.body).toContain("invalid_client");
    });

    it("keeps recording while the alert is throttled", async () => {
        install("epic");
        throttle.ok = false;
        await recordConnectionFailure("epic", "Epic refused the token request (500)");

        expect(alerts).toHaveLength(0);
        // The screen reads this, and it should say what happened last rather than
        // what happened the last time an alert was due.
        expect((await connectionFailure("epic"))?.reason).toContain("500");
    });

    it("says nothing about a service that was never configured", async () => {
        await recordConnectionFailure("epic", "Epic refused the token request (401)");
        expect(alerts).toHaveLength(0);
        expect(await connectionFailure("epic")).toBeNull();
    });

    it("never throws at the person waiting on the redirect", async () => {
        install("epic");
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        broken.write = true;

        await expect(recordConnectionFailure("epic", "anything")).resolves.toBeUndefined();
        vi.restoreAllMocks();
    });
});

describe("clearConnectionFailure", () => {
    it("forgets it once an authorization completes", async () => {
        install("epic", { clientId: "abc", lastFailure: { at: "2026-08-11T00:00:00.000Z", reason: "invalid_client" } });
        await clearConnectionFailure("epic");

        expect(await connectionFailure("epic")).toBeNull();
        // Only the failure: the application itself has to survive it.
        expect(rows.get("epic")?.config.clientId).toBe("abc");
    });

    it("does nothing when there was none", async () => {
        install("epic", { clientId: "abc" });
        await clearConnectionFailure("epic");
        expect(rows.get("epic")?.config).toEqual({ clientId: "abc" });
    });
});
