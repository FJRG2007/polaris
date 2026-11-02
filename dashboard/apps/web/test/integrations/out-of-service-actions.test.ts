/**
 * What an operator does about a paid service that stopped: mark it seen, and save
 * its settings. Neither service is a connection provider, and saving must not wipe
 * the failure before it is cleared, or its alert stays in the bell for good.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { failure, marked, saved, cleared, stored } = vi.hoisted(() => ({
    failure: { held: null as { kind: string; reason: string; at: string } | null },
    marked: [] as string[],
    saved: [] as { provider: string; config?: Record<string, unknown> }[],
    cleared: [] as string[],
    stored: { config: {} as Record<string, unknown> }
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/session", () => ({ requireAdmin: async () => ({ id: "admin-1" }) }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/connections/attention", () => ({
    connectionFailure: async () => failure.held,
    markConnectionFailureSeen: async (provider: string) => {
        marked.push(provider);
        return true;
    }
}));
vi.mock("@/lib/integrations/provider-pause", () => ({
    clearProviderPause: async (provider: string) => {
        cleared.push(provider);
    }
}));
vi.mock("@/lib/integration-service", async (original) => ({
    ...(await original<object>()),
    getIntegrationState: async () => ({
        enabled: true,
        hasSecret: true,
        config: stored.config
    }),
    upsertIntegration: async (
        provider: string,
        input: { config?: Record<string, unknown> }
    ) => {
        saved.push({ provider, config: input.config });
    }
}));

const { dismissConnectionFailureAction, saveDymoAction } = await import(
    "@/app/(app)/admin/integrations/actions"
);

beforeEach(() => {
    failure.held = null;
    stored.config = {};
    marked.length = 0;
    saved.length = 0;
    cleared.length = 0;
});

describe("marking a stopped service seen", () => {
    const stopped = { kind: "out-of-service", reason: "credits", at: "2026-11-02T00:00:00.000Z" };

    it.each(["dymo", "criminalip"])("accepts %s, which holds a failure", async (provider) => {
        failure.held = stopped;
        expect(await dismissConnectionFailureAction(provider)).toEqual({});
        expect(marked).toEqual([provider]);
    });

    it("still refuses a service that is neither known nor failing", async () => {
        expect(await dismissConnectionFailureAction("nothing-here")).toEqual({
            error: "integrations.errors.unknownService"
        });
        expect(marked).toEqual([]);
    });
});

describe("saving Dymo", () => {
    it("keeps the held failure for the clear that follows to answer", async () => {
        const lastFailure = { kind: "out-of-service", reason: "credits" };
        stored.config = { lastFailure, verifyAccessIp: false };
        await saveDymoAction({ enabled: true, verifyAccessIp: true, deny: ["FRAUD"] });
        expect(saved[0]?.config).toEqual({
            lastFailure,
            verifyAccessIp: true,
            deny: ["FRAUD"]
        });
        expect(cleared).toEqual(["dymo"]);
    });
});
