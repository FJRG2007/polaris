/**
 * Polar's usage over a period: summed in the database on the person's own
 * rows, every day of the window present, the chats named only when they are
 * the person's own, and the screen drawing it in the reader's language.
 */

import { withMessages } from "../setup/i18n";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const state = vi.hoisted(() => ({
    raw: [] as unknown[],
    groups: [] as Record<string, any>[],
    threads: [] as Record<string, any>[]
}));

vi.mock("@polaris/db", () => ({
    Prisma: { sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }) },
    prisma: {
        $queryRaw: async (query: unknown) => {
            state.raw.push(query);
            return [
                { day: new Date("2026-10-14T00:00:00Z"), answers: 2n, input: 300n, output: 100n, cost: 0.5 },
                { day: new Date("2026-10-15T00:00:00Z"), answers: 1n, input: 50n, output: 10n, cost: null }
            ];
        },
        polarUsage: {
            groupBy: async (args: Record<string, any>) => {
                state.groups.push(args);
                if (args.by[0] === "threadId")
                    return [
                        { threadId: "t1", _count: { _all: 2 }, _sum: { inputTokens: 300, outputTokens: 100, costUsd: 0.5 } },
                        { threadId: "t2", _count: { _all: 1 }, _sum: { inputTokens: 50, outputTokens: 10, costUsd: null } }
                    ];
                if (args.where.costUsd === null)
                    return [{ provider: "openai", model: "gpt-x", payer: "own", _count: { _all: 1 } }];
                return [
                    {
                        provider: "openai",
                        model: "gpt-x",
                        payer: "own",
                        _count: { _all: 3 },
                        _sum: { inputTokens: 350, outputTokens: 110, cachedTokens: 200, costUsd: 0.5 }
                    }
                ];
            }
        },
        polarThread: {
            findMany: async (args: Record<string, any>) => {
                state.threads.push(args);
                return [{ id: "t1", title: "Release notes" }];
            }
        }
    }
}));
vi.mock("@/app/(app)/polar/settings/routing-actions", () => ({ loadUsageReportAction: async () => ({}) }));
vi.mock("@/components/logos", () => ({ IntegrationLogo: () => null }));

const report = await import("@/lib/polar/usage-report");
const { UsageReportData } = await import("@/app/(app)/polar/settings/polar-usage-report");

const NOW = new Date("2026-10-15T10:30:00Z");

describe("Polar's usage report", () => {
    it("spans whole UTC days ending today, a quiet day a zero", () => {
        const { from, to } = report.windowDays("7d", NOW);
        expect(new Date(from).toISOString()).toBe("2026-10-09T00:00:00.000Z");
        expect(new Date(to).toISOString()).toBe("2026-10-15T00:00:00.000Z");
        const days = report.foldDays([], from, to);
        expect(days).toHaveLength(7);
        expect(days[0]).toMatchObject({ answers: 0, inputTokens: 0, costUsd: 0 });
    });

    it("sums on the person's own rows and names only their own chats", async () => {
        const result = await report.polarUsageReport("user-1", "7d", NOW);
        expect(state.raw).toHaveLength(1);
        expect((state.raw[0] as { values: unknown[] }).values).toEqual(["user-1", new Date("2026-10-09T00:00:00Z")]);
        for (const query of state.groups) {
            expect(query.where.userId).toBe("user-1");
            expect(query.where.createdAt.gte.toISOString()).toBe("2026-10-09T00:00:00.000Z");
        }
        const chats = state.groups.find((query) => query.by[0] === "threadId")!;
        expect(chats.take).toBe(report.REPORT_CHATS);
        expect(state.threads[0].where).toEqual({ id: { in: ["t1", "t2"] }, userId: "user-1" });

        expect(result.days).toHaveLength(7);
        expect(result.days.at(-2)).toMatchObject({ answers: 2, inputTokens: 300, outputTokens: 100, costUsd: 0.5 });
        expect(result.days.at(-1)).toMatchObject({ answers: 1, inputTokens: 50, costUsd: 0 });
        expect(result.totals).toEqual({
            answers: 3,
            inputTokens: 350,
            outputTokens: 110,
            cachedTokens: 200,
            costUsd: 0.5,
            unpriced: 1
        });
        expect(result.chats).toEqual([
            { threadId: "t1", title: "Release notes", answers: 2, tokens: 400, costUsd: 0.5 },
            { threadId: "t2", title: null, answers: 1, tokens: 60, costUsd: 0 }
        ]);
    });

    it("draws the period with its chart, models and chats", async () => {
        const result = await report.polarUsageReport("user-1", "7d", NOW);
        const markup = renderToStaticMarkup(
            withMessages(
                <UsageReportData load={{ state: "ready", report: result }} providers={null} onRetry={() => {}} />
            )
        );
        expect(markup).toContain("<svg");
        expect(markup).toContain('href="/polar?thread=t1"');
        expect(markup).toContain("Deleted chat");
        expect(markup).toContain("1 answer has no published price");
    });

    it("says so when there is nothing to draw, and offers a retry on failure", () => {
        const empty = renderToStaticMarkup(
            withMessages(
                <UsageReportData
                    load={{
                        state: "ready",
                        report: {
                            range: "7d",
                            from: 0,
                            to: 0,
                            totals: { answers: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, unpriced: 0 },
                            days: [],
                            models: [],
                            chats: []
                        }
                    }}
                    providers={null}
                    onRetry={() => {}}
                />
            )
        );
        expect(empty).toContain("No answers in this period.");
        const failed = renderToStaticMarkup(
            withMessages(<UsageReportData load={{ state: "failed" }} providers={null} onRetry={() => {}} />, "es-ES")
        );
        expect(failed).toContain("Reintentar");
    });
});
