// @vitest-environment jsdom

/**
 * The Insights screen past one read's worth of servers: it pages instead of
 * dropping the rest, and a link to one server opens on the page that holds it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const rows = Array.from({ length: 230 }, (_, index) => ({ id: `host-${index}`, name: `node-${index}` }));
const shown: { servers: { id: string }[]; initialFilter: string | null }[] = [];

vi.mock("@/lib/session", () => ({ requirePermission: async () => ({ id: "owner" }) }));
vi.mock("@/lib/i18n/request", () => ({
    getTranslations: async () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key} ${JSON.stringify(values)}` : key
}));
vi.mock("../../src/app/(app)/apps/servers/server-rows", () => ({ listServerRows: async () => rows }));
vi.mock("../../src/app/(app)/apps/servers/insights/server-insights-panel", () => ({
    ServerInsightsPanel: (props: { servers: { id: string }[]; initialFilter: string | null }) => {
        shown.push(props);
        return null;
    }
}));

const { default: ServerInsightsPage } = await import("../../src/app/(app)/apps/servers/insights/page");

async function open(params: Record<string, string>) {
    shown.length = 0;
    render(await ServerInsightsPage({ searchParams: Promise.resolve(params) }));
    return shown[0]!;
}

afterEach(cleanup);

describe("ServerInsightsPage", () => {
    it("reads the first hundred and says how many there are", async () => {
        const panel = await open({});
        expect(panel.servers.map((server) => server.id)).toEqual(rows.slice(0, 100).map((row) => row.id));
        expect(screen.getByText(/insights\.pages\.range/).textContent).toContain('"from":1,"to":100,"total":230');
    });

    it("pages to the rest", async () => {
        const panel = await open({ page: "3" });
        expect(panel.servers.map((server) => server.id)).toEqual(rows.slice(200).map((row) => row.id));
    });

    it("opens a link to one server on the page that holds it", async () => {
        const panel = await open({ server: "host-150" });
        expect(panel.servers.some((server) => server.id === "host-150")).toBe(true);
        expect(panel.initialFilter).toBe("host-150");
    });
});
