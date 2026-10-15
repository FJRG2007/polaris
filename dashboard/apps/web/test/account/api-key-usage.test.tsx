/**
 * One key's usage screen: the action reads only the signed-in owner's keys, so
 * another account's key id answers exactly like one that does not exist, and
 * the data region says what happened when there is nothing to draw.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { withMessages } from "../setup/i18n";

const OWN_KEY = "11111111-1111-4111-8111-111111111111";
const OTHER_KEY = "22222222-2222-4222-8222-222222222222";

const state = vi.hoisted(() => ({
    lookups: [] as Record<string, unknown>[],
    reports: [] as string[]
}));

vi.mock("@/lib/session", () => ({ requireUser: async () => ({ id: "user-1", isAdmin: false }) }));
vi.mock("@polaris/db", () => ({
    prisma: {
        apiKey: {
            findFirst: async (args: { where: { id: string; userId: string } }) => {
                state.lookups.push(args.where);
                const owned = args.where.id === OWN_KEY && args.where.userId === "user-1";
                return owned ? { id: OWN_KEY } : null;
            }
        }
    }
}));
vi.mock("@/lib/api-usage/report", () => ({
    USAGE_RANGES: ["24h", "7d", "30d", "90d"],
    keyUsageReport: async (keyId: string, range: string) => {
        state.reports.push(keyId);
        return {
            range,
            from: 0,
            to: 0,
            bucket: "hour",
            total: 0,
            classes: { success: 0, client: 0, server: 0 },
            p50: null,
            p95: null,
            series: [],
            routes: [],
            statuses: []
        };
    }
}));

const { keyUsageAction } = await import("@/app/(app)/account/api-keys/usage-actions");
const { UsageData } = await import("@/app/(app)/account/api-keys/[keyId]/usage/key-usage-view");

beforeEach(() => {
    state.lookups.length = 0;
    state.reports.length = 0;
});

describe("a key's usage action", () => {
    it("refuses another account's key as not found, without reading its usage", async () => {
        const result = await keyUsageAction({ keyId: OTHER_KEY, range: "24h" });
        expect(result).toEqual({ error: "notFound" });
        expect(state.lookups).toEqual([{ id: OTHER_KEY, userId: "user-1" }]);
        expect(state.reports).toEqual([]);
    });

    it("refuses a malformed id or period before touching the database", async () => {
        expect(await keyUsageAction({ keyId: "not-a-key", range: "24h" })).toEqual({ error: "invalid" });
        expect(await keyUsageAction({ keyId: OWN_KEY, range: "1y" })).toEqual({ error: "invalid" });
        expect(state.lookups).toEqual([]);
    });

    it("returns an empty report for the owner's quiet key", async () => {
        const result = await keyUsageAction({ keyId: OWN_KEY, range: "7d" });
        expect(result.usage?.total).toBe(0);
        expect(result.usage?.anchors).toEqual([]);
        expect(state.reports).toEqual([OWN_KEY]);
    });
});

describe("the usage data region", () => {
    const empty = {
        range: "24h" as const,
        from: 0,
        to: 0,
        bucket: "hour" as const,
        total: 0,
        classes: { success: 0, client: 0, server: 0 },
        p50: null,
        p95: null,
        series: [],
        routes: [],
        statuses: [],
        anchors: []
    };

    it("says there were no calls rather than drawing empty tables", () => {
        const markup = renderToStaticMarkup(withMessages(<UsageData load={{ state: "ready", usage: empty }} onRetry={() => {}} />));
        expect(markup).toContain("No calls in this period");
        expect(markup).not.toContain("<table");
    });

    it("offers a retry when the report failed, in the reader's language", () => {
        const markup = renderToStaticMarkup(
            withMessages(<UsageData load={{ state: "failed" }} onRetry={() => {}} />, "es-ES")
        );
        expect(markup).toContain("No se pudo cargar el uso");
        expect(markup).toContain("Reintentar");
    });

    it("draws the calls, routes and statuses once there are some", () => {
        const usage = {
            ...empty,
            total: 3,
            classes: { success: 2, client: 1, server: 0 },
            series: [
                { t: Date.UTC(2026, 9, 15, 9), calls: 2, errors: 0 },
                { t: Date.UTC(2026, 9, 15, 10), calls: 1, errors: 1 }
            ],
            routes: [{ method: "GET", route: "/api/v1/me", calls: 3, errors: 1, p50: { ms: 20, over: false }, p95: null }],
            statuses: [
                { status: 200, calls: 2 },
                { status: 404, calls: 1 }
            ],
            anchors: ["getMe"]
        };
        const markup = renderToStaticMarkup(withMessages(<UsageData load={{ state: "ready", usage }} onRetry={() => {}} />));
        expect(markup).toContain("GET /api/v1/me");
        expect(markup).toContain('href="/account/api-keys/reference#getMe"');
        expect(markup).toContain(">404<");
        expect(markup).toContain("<svg");
    });
});
