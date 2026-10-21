/**
 * The admin marketplace lists instance-wide apps somebody else installed beside the
 * reader's own. Those rows must not carry who owns them or where they run, and
 * carry the service id only to a reader who may uninstall them - the one thing
 * the page reads it for.
 */

import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledAppView } from "@/lib/apps/install-service";

const uninstallable = vi.hoisted(() => ({ ids: new Set<string>() }));

vi.mock("next/navigation", () => ({
    notFound: () => {
        throw new Error("not found");
    },
    redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
    }
}));
vi.mock("@/lib/session", () => ({
    requireAdmin: vi.fn(async () => ({ id: "reader-1", isAdmin: true })),
    sessionCan: vi.fn(async () => true)
}));
vi.mock("@/lib/apps/install-access", () => ({
    uninstallAccess: vi.fn(async (_user: unknown, id: string) =>
        uninstallable.ids.has(id) ? { ownerId: "owner-2", isOwner: false } : null
    )
}));
vi.mock("@/lib/app-extensions/registry", () => ({ adoptAppInstalls: vi.fn(async () => {}) }));
vi.mock("@/lib/mail-server/app-install", () => ({ adoptMailServerApp: vi.fn(async () => {}) }));
vi.mock("@/lib/apps/install-service", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/apps/install-service")>();
    return {
        installForReader: actual.installForReader,
        instanceWideInstallIds: vi.fn(async () => ["install-theirs"]),
        listInstalledApps: vi.fn(
            async (): Promise<InstalledAppView[]> => [
                row("install-mine", "reader-1"),
                row("install-theirs", "owner-2")
            ]
        )
    };
});
vi.mock("@/app/(app)/apps/marketplace/marketplace-view", () => ({ MarketplaceView: () => null }));
vi.mock("@/app/(app)/apps/marketplace/[appId]/app-detail", () => ({
    AppDetail: () => null,
    AppInstallPanel: () => null,
    AppInstallPanelSkeleton: () => null
}));

function row(id: string, ownerId: string): InstalledAppView {
    return {
        id,
        catalogId: "calendar",
        name: "Calendar",
        status: "running",
        applicationId: `app-of-${id}`,
        targetId: `target-of-${id}`,
        createdAt: new Date("2026-01-01").toISOString(),
        ownerId
    };
}

const { default: MarketplacePage } = await import("@/app/(app)/admin/apps/page");
const { default: MarketplaceAppPage } = await import("@/app/(app)/admin/apps/[appId]/page");

type Row = Record<string, unknown>;

/** The rows the grid hands its client component. */
async function gridRows(): Promise<Row[]> {
    const page = (await MarketplacePage({
        searchParams: Promise.resolve({})
    })) as ReactElement<{ installed: Row[] }>;
    return page.props.installed;
}

/** The rows the app page's install panel is handed. */
async function detailRows(): Promise<Row[]> {
    const page = (await MarketplaceAppPage({
        params: Promise.resolve({ appId: "calendar" })
    })) as ReactElement<{ children: ReactElement<{ children: ReactElement }> }>;
    const state = page.props.children.props.children;
    const render = state.type as (props: unknown) => Promise<ReactElement<{ installs: Row[] }>>;
    return (await render(state.props)).props.installs;
}

describe.each([
    ["the grid", gridRows],
    ["an app's page", detailRows]
])("the installs %s sends", (_where, rows) => {
    beforeEach(() => {
        uninstallable.ids = new Set();
    });

    it("sends the reader's own install whole", async () => {
        const mine = (await rows()).find((item) => item.id === "install-mine");
        expect(mine).toMatchObject({
            ownerId: "reader-1",
            targetId: "target-of-install-mine",
            applicationId: "app-of-install-mine"
        });
    });

    it("drops the owner, target and service of somebody else's they may not uninstall", async () => {
        const theirs = (await rows()).find((item) => item.id === "install-theirs");
        expect(theirs).toBeDefined();
        expect(theirs).not.toHaveProperty("ownerId");
        expect(theirs).not.toHaveProperty("targetId");
        expect(theirs?.applicationId).toBeNull();
        expect(JSON.stringify(theirs)).not.toMatch(/owner-2|target-of|app-of/);
    });

    it("keeps the service id for one they may uninstall, and still not its owner or target", async () => {
        uninstallable.ids = new Set(["install-theirs"]);
        const theirs = (await rows()).find((item) => item.id === "install-theirs");
        expect(theirs?.applicationId).toBe("app-of-install-theirs");
        expect(theirs).not.toHaveProperty("ownerId");
        expect(theirs).not.toHaveProperty("targetId");
    });
});
