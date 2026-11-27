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
    reports: [] as string[],
    listed: [] as Record<string, unknown>[],
    summed: [] as { keyIds: string[]; options: unknown }[],
    revealed: [] as { keyIds: string[]; options: unknown }[]
}));

vi.mock("@/lib/session", () => ({ requireUser: async () => ({ id: "user-1", isAdmin: false }) }));
vi.mock("@polaris/db", () => ({
    prisma: {
        apiKey: {
            findFirst: async (args: { where: { id: string; userId: string } }) => {
                state.lookups.push(args.where);
                const owned = args.where.id === OWN_KEY && args.where.userId === "user-1";
                return owned ? { id: OWN_KEY } : null;
            },
            findMany: async (args: { where: Record<string, unknown> }) => {
                state.listed.push(args.where);
                return [
                    {
                        id: OWN_KEY,
                        name: "Deploy bot",
                        prefix: "pk_abc",
                        lastUsedAt: new Date("2026-10-15T09:00:00Z"),
                        revokedAt: null
                    }
                ];
            }
        }
    }
}));
const quietReport = (range: string) => ({
    range,
    from: 0,
    to: 0,
    bucket: "hour",
    total: 0,
    classes: { success: 0, client: 0, server: 0 },
    p50: null,
    p95: null,
    p99: null,
    series: [],
    routes: [],
    statuses: [],
    keys: []
});

vi.mock("@/lib/api-usage/callers", () => ({
    callerReport: async (keyIds: string[], _since: Date, options: unknown) => {
        state.revealed.push({ keyIds, options });
        return { clients: [], addresses: [{ name: "203.0.113.7", calls: 1, errors: 0 }], recorded: 1 };
    }
}));

vi.mock("@/lib/api-usage/report", () => ({
    USAGE_RANGES: ["24h", "7d", "30d", "90d"],
    windowStart: () => 0,
    usageReport: async (keyIds: string[], range: string, options: unknown) => {
        state.summed.push({ keyIds, options });
        return quietReport(range);
    },
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

const { accountUsageAction, keyUsageAction, usageAddressesAction } = await import(
    "@/app/(app)/account/api-keys/usage-actions"
);
const { UsageData, usageCsv } = await import("@/app/(app)/account/api-keys/[keyId]/usage/key-usage-view");

beforeEach(() => {
    state.lookups.length = 0;
    state.reports.length = 0;
    state.listed.length = 0;
    state.summed.length = 0;
    state.revealed.length = 0;
});

describe("revealing the full addresses", () => {
    it("reads only the owner's keys, and only then asks for the addresses unmasked", async () => {
        const result = await usageAddressesAction({ keyId: OWN_KEY, range: "24h" });
        expect(state.listed).toEqual([
            { userId: "user-1", kind: { notIn: ["cli", "streamdeck", "tv", "terminal"] }, id: OWN_KEY }
        ]);
        expect(state.revealed).toEqual([{ keyIds: [OWN_KEY], options: { reveal: true } }]);
        expect(result.addresses?.[0]?.name).toBe("203.0.113.7");
    });

    it("refuses a malformed request before touching the database", async () => {
        expect(await usageAddressesAction({ keyId: "nope", range: "24h" })).toEqual({ error: "invalid" });
        expect(state.listed).toEqual([]);
    });
});

describe("the account's usage overview", () => {
    it("sums only the signed-in account's own keys, sessions of devices left out", async () => {
        const result = await accountUsageAction({ range: "30d" });
        expect(state.listed).toEqual([
            { userId: "user-1", kind: { notIn: ["cli", "streamdeck", "tv", "terminal"] } }
        ]);
        expect(state.summed).toEqual([{ keyIds: [OWN_KEY], options: { shares: true } }]);
        expect(result.usage?.labels).toEqual([
            {
                id: OWN_KEY,
                name: "Deploy bot",
                prefix: "pk_abc",
                lastUsedAt: "2026-10-15T09:00:00.000Z",
                revoked: false
            }
        ]);
    });

    it("refuses a period it does not offer before touching the database", async () => {
        expect(await accountUsageAction({ range: "1y" })).toEqual({ error: "invalid" });
        expect(state.listed).toEqual([]);
    });
});

describe("a key's usage action", () => {
    it("refuses another account's key as not found, without reading its usage", async () => {
        const result = await keyUsageAction({ keyId: OTHER_KEY, range: "24h" });
        expect(result).toEqual({ error: "notFound" });
        // A device's sign-in is a session, not a key: its id reads as unknown here too.
        expect(state.lookups).toEqual([
            {
                id: OTHER_KEY,
                userId: "user-1",
                kind: { notIn: ["cli", "streamdeck", "tv", "terminal"] }
            }
        ]);
        expect(state.reports).toEqual([]);
    });

    it("refuses a malformed id or period before touching the database", async () => {
        expect(await keyUsageAction({ keyId: "not-a-key", range: "24h" })).toEqual({
            error: "invalid"
        });
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
        p99: null,
        series: [],
        routes: [],
        statuses: [],
        keys: [],
        anchors: []
    };

    it("says there were no calls rather than drawing empty tables", () => {
        const markup = renderToStaticMarkup(
            withMessages(<UsageData load={{ state: "ready", usage: empty }} onRetry={() => {}} />)
        );
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
            routes: [
                {
                    method: "GET",
                    route: "/api/v1/me",
                    calls: 3,
                    errors: 1,
                    p50: { ms: 20, over: false },
                    p95: null,
                    p99: null
                }
            ],
            statuses: [
                { status: 200, calls: 2 },
                { status: 404, calls: 1 }
            ],
            anchors: ["getMe"]
        };
        const markup = renderToStaticMarkup(
            withMessages(<UsageData load={{ state: "ready", usage }} onRetry={() => {}} />)
        );
        expect(markup).toContain("GET /api/v1/me");
        expect(markup).toContain('href="/account/api-keys/reference#getMe"');
        expect(markup).toContain(">404<");
        expect(markup).toContain("<svg");
        expect(markup).toContain("Export CSV");
        expect(markup).not.toContain("By key");
        // A report kept from before callers were counted draws no caller tables.
        expect(markup).not.toContain("By client");
    });

    it("lists the callers, addresses masked, with what predates the counting as not recorded", () => {
        const usage = {
            ...empty,
            total: 10,
            classes: { success: 10, client: 0, server: 0 },
            series: [{ t: Date.UTC(2026, 9, 15, 9), calls: 10, errors: 0 }],
            clients: [
                { name: "Python requests", calls: 6, errors: 0 },
                { name: "", calls: 1, errors: 0 }
            ],
            addresses: [{ name: "203.0.113.0/24", calls: 7, errors: 0 }],
            unrecorded: 3
        };
        const markup = renderToStaticMarkup(
            withMessages(<UsageData load={{ state: "ready", usage }} onRetry={() => {}} keyId={OWN_KEY} />)
        );
        expect(markup).toContain("By client");
        expect(markup).toContain("Python requests");
        expect(markup).toContain("No user-agent sent");
        expect(markup).toContain("203.0.113.0/24");
        expect(markup).toContain("Not recorded");
        expect(markup).toContain("30%");
        expect(markup).toContain("Show full");
    });

    it("lists each key's share on the overview, a row opening that key", () => {
        const usage = {
            ...empty,
            total: 4,
            classes: { success: 3, client: 1, server: 0 },
            series: [{ t: Date.UTC(2026, 9, 15, 9), calls: 4, errors: 1 }],
            keys: [
                { apiKeyId: OWN_KEY, calls: 3, errors: 1, p50: null, p95: null },
                { apiKeyId: OTHER_KEY, calls: 1, errors: 0, p50: null, p95: null }
            ]
        };
        const labels = [
            { id: OWN_KEY, name: "Deploy bot", prefix: "pk_abc", lastUsedAt: null, revoked: true },
            { id: "33333333-3333-4333-8333-333333333333", name: "Quiet", prefix: "pk_q", lastUsedAt: null, revoked: false }
        ];
        const markup = renderToStaticMarkup(
            withMessages(
                <UsageData load={{ state: "ready", usage }} onRetry={() => {}} labels={labels} />
            )
        );
        expect(markup).toContain(`href="/account/api-keys/${OWN_KEY}/usage"`);
        expect(markup).toContain("Revoked");
        // A key since deleted still counts, under a name that says so.
        expect(markup).toContain("Deleted key");
        expect(markup).toContain("1 more key had no calls in this period.");
        expect(markup).toContain("25%");
    });

    it("exports routes and keys as a spreadsheet that cannot run a formula", () => {
        const csv = usageCsv(
            {
                ...empty,
                routes: [
                    { method: "GET", route: "/api/v1/me", calls: 3, errors: 1, p50: { ms: 20, over: false }, p95: null, p99: null }
                ],
                keys: [{ apiKeyId: OWN_KEY, calls: 3, errors: 1, p50: null, p95: null }]
            },
            [{ id: OWN_KEY, name: "=cmd", prefix: "pk_abc", lastUsedAt: null, revoked: false }],
            { route: "Route", key: "Key", calls: "Calls", errors: "Errors", p50: "p50", p95: "p95", p99: "p99" }
        );
        expect(csv.split("\n")).toEqual([
            '"Route","Calls","Errors","p50","p95","p99"',
            '"GET /api/v1/me","3","1","20","",""',
            "",
            '"Key","Calls","Errors","p50","p95"',
            `"'=cmd (pk_abc)","3","1","",""`,
            ""
        ]);
    });
});
