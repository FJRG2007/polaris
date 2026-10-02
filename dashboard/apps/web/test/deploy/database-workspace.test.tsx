// @vitest-environment jsdom

/**
 * The Database tab mounted for real: Data (the Databases workbench bound to
 * this one database, read-only until a confirmed switch), Stats (connections,
 * cache hit, sizes, table health, vacuum, unused indexes, pg_stat_statements),
 * Config (credentials with a regenerate that names what restarts, extensions)
 * and Connect (the private reference, and a public URL masked until shown).
 * `database-data-actions.test.ts` covers the server actions behind these;
 * this is what somebody actually sees drawn from their answers - there is no
 * browser or Docker host available here to drive a real page render against.
 */

import { MessagesWrapper } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import type { HealthReport } from "@/lib/data/health";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { DatabaseWorkspace } from "@/app/(app)/apps/deploy/database-workspace";
import type { ConnectInfo } from "@/app/(app)/apps/deploy/database-data-actions";

const managedBrowseAction = vi.fn();
const managedRowsAction = vi.fn();
const managedStatsAction = vi.fn();
const managedInsightsAction = vi.fn();
const databaseHealthAction = vi.fn();
const vacuumTableAction = vi.fn();
const enableStatStatementsAction = vi.fn();
const databaseConnectInfoAction = vi.fn();
const passwordDependentsAction = vi.fn();
const regeneratePasswordAction = vi.fn();
const listExtensionsAction = vi.fn();
const setExtensionAction = vi.fn();
const setPublicPortAction = vi.fn();

vi.mock("@/app/(app)/apps/deploy/database-data-actions", () => ({
    managedBrowseAction: (...args: unknown[]) => managedBrowseAction(...args),
    managedRowsAction: (...args: unknown[]) => managedRowsAction(...args),
    managedRunAction: vi.fn(),
    managedUpdateCellAction: vi.fn(),
    managedInsertRowAction: vi.fn(),
    managedDeleteRowsAction: vi.fn(),
    managedCreateTableAction: vi.fn(),
    managedRedisValueAction: vi.fn(),
    managedStatsAction: (...args: unknown[]) => managedStatsAction(...args),
    managedInsightsAction: (...args: unknown[]) => managedInsightsAction(...args),
    databaseHealthAction: (...args: unknown[]) => databaseHealthAction(...args),
    vacuumTableAction: (...args: unknown[]) => vacuumTableAction(...args),
    enableStatStatementsAction: (...args: unknown[]) => enableStatStatementsAction(...args),
    databaseConnectInfoAction: (...args: unknown[]) => databaseConnectInfoAction(...args),
    passwordDependentsAction: (...args: unknown[]) => passwordDependentsAction(...args),
    regeneratePasswordAction: (...args: unknown[]) => regeneratePasswordAction(...args),
    listExtensionsAction: (...args: unknown[]) => listExtensionsAction(...args),
    setExtensionAction: (...args: unknown[]) => setExtensionAction(...args),
    setPublicPortAction: (...args: unknown[]) => setPublicPortAction(...args)
}));

// `deploy-view.tsx` is where `CopyRow` lives, and it also re-exports the whole
// Deploy service panel (`DatabaseManageDialog` among it), which at import time
// pulls in every Deploy server action and the session/auth module that needs
// real environment secrets. `CopyRow` itself is a small, side-effect-free
// presentational piece, so it is reproduced here rather than dragging that
// graph in just to resolve one export.
vi.mock("@/app/(app)/apps/deploy/deploy-view", () => ({
    CopyRow: ({ value, secret, copyValue }: { value: string; secret?: boolean; copyValue?: string }) => {
        const shown = secret ? value.replace(/:\/\/([^:]*):[^@]*@/, "://$1:********@") : value;
        return (
            <span>
                <code title={shown}>{shown}</code>
                <button type="button" aria-label="Copy" onClick={() => void navigator.clipboard?.writeText(copyValue ?? value)}>
                    Copy
                </button>
            </span>
        );
    }
}));

// The workbench's other home (the Databases app) reaches its own server
// actions through this module at import time, pulling in session/auth code
// that needs real environment secrets. The Deploy Database tab never calls
// it - it hands the workbench `managedSource` instead - so it only needs to
// exist, not to do anything.
vi.mock("@/app/(app)/apps/databases/actions", () => ({
    browseAction: vi.fn(),
    rowsAction: vi.fn(),
    runAction: vi.fn(),
    updateCellAction: vi.fn(),
    insertRowAction: vi.fn(),
    deleteRowsAction: vi.fn(),
    createTableAction: vi.fn(),
    redisValueAction: vi.fn(),
    statsAction: vi.fn(),
    insightsAction: vi.fn()
}));

const DATABASE = { id: "11111111-1111-1111-1111-111111111111", name: "orders-db", engine: "postgres" };

const HEALTH: HealthReport = {
    engine: "postgres",
    at: Date.now(),
    connections: { used: 4, max: 20, active: 1, idle: 3, idleInTransaction: 0 },
    cacheHitRatio: 0.993,
    sizes: [
        { key: "tables", bytes: 52_428_800 },
        { key: "indexes", bytes: 10_485_760 }
    ],
    tables: [
        {
            schema: "public",
            name: "orders",
            rows: 48_210,
            dataBytes: 41_943_040,
            indexBytes: 8_388_608,
            seqScans: 12,
            idxScans: 9_340,
            deadRows: 6_200,
            deadPercent: 12.8,
            lastVacuum: "2026-09-29T10:00:00.000Z",
            lastAutovacuum: null,
            xidAge: 102_300,
            freeBytes: null
        }
    ],
    tablesTotal: 1,
    vacuum: { databaseXidAge: 102_300, freezeMaxAge: 200_000_000, freezeRisk: false },
    unusedIndexes: [{ schema: "public", table: "orders", name: "orders_legacy_idx", bytes: 1_048_576, scans: 0 }],
    queries: {
        available: true,
        installed: true,
        preloaded: true,
        rows: [{ statement: "SELECT * FROM orders WHERE id = $1", calls: 940, rows: 940, totalMs: 812.4, meanMs: 0.86, maxMs: 14.2 }]
    },
    facts: []
};

const CONNECT_INFO: ConnectInfo = {
    connection: {
        host: "orders-db.polaris.internal",
        port: 5432,
        database: "orders",
        username: "orders_app",
        password: "s3cret-pass",
        uri: "postgresql://orders_app:s3cret-pass@orders-db.polaris.internal:5432/orders",
        exposedPort: 25432,
        reference: "orders-db",
        cluster: null,
        hosts: ["orders-db.polaris.internal"],
        replicaSet: null,
        readUri: null
    } as ConnectInfo["connection"],
    publicHost: "203.0.113.10",
    referenceKeys: ["DATABASE_URL", "PGHOST", "PGPORT"],
    slug: "orders-db"
};

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    // The Stats tab caches its report in `sessionStorage` under the
    // database's id (`snapshot-cache.ts`) so a revisit paints before the
    // request lands - which otherwise leaks one test's report into the next
    // one's first render, since every test shares `DATABASE.id`.
    sessionStorage.clear();
});

// Every view ends in the same "Live" block (`StatsPanel`, bound through
// `managedSource` regardless of which tab is open), so these two need an
// answer in every test or that panel's own fetch rejects on `undefined`.
beforeEach(() => {
    managedBrowseAction.mockResolvedValue({
        shape: "sql",
        namespaces: [{ name: "public", kind: "schema" }],
        relations: [{ name: "orders", namespace: "public", kind: "table", rows: 48_210 }],
        namespace: "public"
    });
    managedStatsAction.mockResolvedValue({ stats: { at: Date.now(), engine: "postgres", gauges: [], counters: [] } });
    managedInsightsAction.mockResolvedValue({ insights: { biggest: [], frequent: [], frequentUnavailable: "" } });
});

function mount(overrides: Partial<Parameters<typeof DatabaseWorkspace>[0]> = {}) {
    render(
        <DatabaseWorkspace database={DATABASE} deployed manage hosted={false} {...overrides} />,
        { wrapper: MessagesWrapper }
    );
}

describe("the Database tab's four views", () => {
    it("opens on Data, read-only, with the workbench listing this database's own tables", async () => {
        managedBrowseAction.mockResolvedValue({
            shape: "sql",
            namespaces: [{ name: "public", kind: "schema" }],
            relations: [{ name: "orders", namespace: "public", kind: "table", rows: 48_210 }],
            namespace: "public"
        });
        await act(async () => mount());

        expect(screen.getByRole("radiogroup", { name: "Database view" })).toBeDefined();
        expect(screen.getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["Data", "Stats", "Config", "Connect"]);
        expect(screen.getByText("Read-only. Browse and query without changing anything.")).toBeDefined();
        expect(await screen.findByText("orders")).toBeDefined();
    });

    it("asks before turning writes on, and only then", async () => {
        const user = userEvent.setup();
        await act(async () => mount());
        await screen.findByText("orders");

        expect(screen.queryByText("Changes allowed. Edits, new rows and statements write to the live database.")).toBeNull();
        await user.click(screen.getByRole("switch", { name: "Read-only" }));
        expect(screen.getByRole("dialog", { name: "Allow changes?" })).toBeDefined();

        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Allow changes" }));
        expect(screen.getByText("Changes allowed. Edits, new rows and statements write to the live database.")).toBeDefined();
    });

    it("draws the Stats report: connections, cache hit, table health, vacuum and pg_stat_statements", async () => {
        const user = userEvent.setup();
        databaseHealthAction.mockResolvedValue({ report: HEALTH });
        await act(async () => mount());
        await user.click(screen.getByRole("radio", { name: "Stats" }));

        expect(await screen.findByText("4")).toBeDefined();
        expect(screen.getByText("/ 20")).toBeDefined();
        expect(screen.getByText("99.3%")).toBeDefined();
        expect(screen.getAllByText("orders").length).toBeGreaterThan(0);
        expect(screen.getByText("48,210")).toBeDefined();
        expect(screen.getByText("1 table has more than 10% dead rows.")).toBeDefined();
        expect(screen.getByText("SELECT * FROM orders WHERE id = $1")).toBeDefined();
        expect(screen.getByText("orders_legacy_idx")).toBeDefined();

        await user.click(screen.getByRole("button", { name: "Vacuum" }));
        expect(screen.getByRole("dialog", { name: "Vacuum orders?" })).toBeDefined();
        vacuumTableAction.mockResolvedValue({});
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Vacuum" }));
        expect(vacuumTableAction).toHaveBeenCalledWith(DATABASE.id, { schema: "public", name: "orders" });
    });

    it("offers Enable when PostgreSQL has not been told to record statement statistics", async () => {
        const user = userEvent.setup();
        databaseHealthAction.mockResolvedValue({
            report: { ...HEALTH, queries: { available: true, installed: false, preloaded: false, rows: [] } }
        });
        await act(async () => mount());
        await user.click(screen.getByRole("radio", { name: "Stats" }));
        expect(await screen.findByText(/pg_stat_statements is loaded/)).toBeDefined();
        expect(screen.getByRole("button", { name: "Enable" })).toBeDefined();
    });

    it("shows the account in Config, masks the password until Show, and names who restarts on regenerate", async () => {
        const user = userEvent.setup();
        databaseConnectInfoAction.mockResolvedValue({ info: CONNECT_INFO });
        passwordDependentsAction.mockResolvedValue({ services: [{ id: "svc-api", name: "api" }] });
        regeneratePasswordAction.mockResolvedValue({ restarted: [{ id: "svc-api", name: "api" }] });
        listExtensionsAction.mockResolvedValue({
            extensions: [
                { name: "plpgsql", defaultVersion: "1.0", installedVersion: "1.0", comment: null },
                { name: "pg_stat_statements", defaultVersion: "1.10", installedVersion: null, comment: "track statement execution statistics" }
            ]
        });

        await act(async () => mount());
        await user.click(screen.getByRole("radio", { name: "Config" }));

        expect(await screen.findByText("orders_app")).toBeDefined();
        expect(screen.getByText("•".repeat(16))).toBeDefined();
        await user.click(screen.getByRole("button", { name: "Show" }));
        expect(screen.getByText("s3cret-pass")).toBeDefined();

        expect(await screen.findByText("Installed (1)")).toBeDefined();
        expect(screen.getByText("Available (1)")).toBeDefined();
        expect(screen.getByText("pg_stat_statements")).toBeDefined();

        await user.click(screen.getByRole("button", { name: "Regenerate password" }));
        expect(screen.getByRole("dialog", { name: "Regenerate the password?" })).toBeDefined();
        expect(screen.getByText("This service restarts: api.")).toBeDefined();

        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Regenerate password" }));
        expect(regeneratePasswordAction).toHaveBeenCalledWith(DATABASE.id);
        expect(await screen.findByText("Password changed. Restarting api.")).toBeDefined();
    });

    it("gives Connect a copyable private reference, and a public URL masked until Show", async () => {
        const user = userEvent.setup();
        databaseConnectInfoAction.mockResolvedValue({ info: CONNECT_INFO });
        await act(async () => mount());
        await user.click(screen.getByRole("radio", { name: "Connect" }));

        expect(await screen.findByText("${{orders-db.DATABASE_URL}}")).toBeDefined();
        expect(screen.getByText("orders-db.polaris.internal")).toBeDefined();
        expect(screen.getByRole("button", { name: "PGHOST" })).toBeDefined();

        await user.click(screen.getByRole("radio", { name: "Public network" }));
        expect(screen.getByText("Anyone who can reach this port can try to sign in. Keep the password private, and close the port when it is not needed.")).toBeDefined();
        expect(screen.getByText("postgresql://orders_app:********@203.0.113.10:25432/orders")).toBeDefined();
        expect(screen.getByText("PGPASSWORD=******** psql -h 203.0.113.10 -p 25432 -U orders_app -d orders")).toBeDefined();
        expect(screen.queryByText((text) => text.includes("s3cret-pass"))).toBeNull();

        await user.click(screen.getByRole("button", { name: "Show" }));
        expect(screen.getByText("postgresql://orders_app:s3cret-pass@203.0.113.10:25432/orders")).toBeDefined();
        expect(screen.getByText("PGPASSWORD=s3cret-pass psql -h 203.0.113.10 -p 25432 -U orders_app -d orders")).toBeDefined();
    });

    it("needs databases.manage, and a provisioned instance, before any of this opens", async () => {
        await act(async () => mount({ manage: false }));
        expect(screen.getByText("Browsing this database needs the right to manage the project's databases.")).toBeDefined();

        cleanup();
        await act(async () => mount({ deployed: false }));
        expect(screen.getByText("Provision it first; there is nothing running to manage yet.")).toBeDefined();
    });
});
