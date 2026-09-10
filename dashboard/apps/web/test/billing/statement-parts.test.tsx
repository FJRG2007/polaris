/**
 * What a statement looks like on screen: a line per project that opens the
 * project, money in the prices' own currency rather than the reader's, the
 * owner column only where lines from several owners sit together, and a
 * skeleton in the table - not a blank screen - while the statement is read.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
    StatementTable,
    StatementTotals,
    type BillingResponse
} from "@/components/billing/statement-parts";

const USAGE = {
    cpuHours: 1.5,
    memoryGbHours: 2048,
    storageGbHours: 0,
    egressGb: 0,
    cpuUnmeasuredHours: 0
};

const VIEW: BillingResponse = {
    statement: {
        month: "2026-09",
        rates: {
            currency: "USD",
            cpuHour: 2,
            memoryGbHour: null,
            storageGbMonth: null,
            egressGb: null
        },
        lines: [
            {
                projectId: "p1",
                projectName: "Storefront",
                owner: { kind: "org", id: "o1", name: "Acme", handle: "acme" },
                usage: USAGE,
                cost: { cpu: 3, memory: null, storage: null, egress: null, total: 3 }
            }
        ],
        owners: [],
        usage: USAGE,
        cost: { cpu: 3, memory: null, storage: null, egress: null, total: 3 }
    },
    monthLabel: "September 2026",
    months: ["2026-09"],
    current: true,
    through: "2026-09-10T12:00:00.000Z",
    keptFrom: null,
    generatedAt: "2026-09-10T12:00:00.000Z"
};

describe("a statement's table", () => {
    it("opens the project from its line and writes money in the prices' currency", () => {
        const html = renderToStaticMarkup(
            <StatementTable view={VIEW} showOwner emptyLabel="None" />
        );
        expect(html).toContain('href="/apps/deploy/p1"');
        expect(html).toContain("Storefront");
        // The reader's default is euros; the statement is in dollars.
        expect(html).toContain("$3.00");
        expect(html).toContain('href="/account/organizations/acme/billing"');
        expect(html).toContain("2,048 GB-h");
    });

    it("leaves the owner out of an organization's own statement", () => {
        const html = renderToStaticMarkup(
            <StatementTable view={VIEW} showOwner={false} emptyLabel="None" />
        );
        expect(html).not.toContain(">Owner<");
        expect(html).not.toContain("/account/organizations/acme/billing");
    });

    it("says so when there are no projects", () => {
        const empty = { ...VIEW, statement: { ...VIEW.statement, lines: [] } };
        const html = renderToStaticMarkup(
            <StatementTable view={empty} showOwner emptyLabel="No projects yet." />
        );
        expect(html).toContain("No projects yet.");
    });

    it("keeps its headings and draws skeleton rows while the statement is on its way", () => {
        const html = renderToStaticMarkup(
            <StatementTable view={null} showOwner emptyLabel="None" />
        );
        expect(html).toContain(">Project<");
        expect(html).toContain("animate-pulse");
        expect(html).not.toContain("None");
    });
});

describe("a statement's totals", () => {
    it("marks what has no price instead of inventing one", () => {
        const html = renderToStaticMarkup(<StatementTotals view={VIEW} />);
        expect(html).toContain("Not priced");
        expect(html).toContain("So far this month");
    });

    it("shows usage without money when no prices are set", () => {
        const unpriced = {
            ...VIEW,
            statement: {
                ...VIEW.statement,
                rates: null,
                cost: null,
                lines: VIEW.statement.lines.map((line) => ({ ...line, cost: null }))
            }
        };
        const html = renderToStaticMarkup(<StatementTotals view={unpriced} />);
        expect(html).toContain("No prices set");
        expect(html).not.toContain("$");
    });
});
