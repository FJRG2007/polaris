/**
 * A game server's settings are the Settings screen's. A viewer who may read the
 * server but not manage it is sent only the ones the overview and the connect
 * card show; anything else on the list must never reach their browser.
 */

import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const held = vi.hoisted(() => ({ value: [] as string[] }));

vi.mock("next/navigation", () => ({
    notFound: () => {
        throw new Error("not found");
    },
    redirect: () => {
        throw new Error("redirect");
    }
}));
vi.mock("@/lib/session", () => ({
    requireUser: vi.fn(async () => ({ id: "viewer-1", isAdmin: false })),
    userHasManage: vi.fn(async () => false)
}));
vi.mock("@/lib/resource-access", () => ({
    resourceAccess: vi.fn(async () => ({ ownerId: "owner-1", isOwner: false })),
    heldOn: vi.fn(async () => [])
}));
vi.mock("@/lib/apps/install-access", () => ({
    installRef: (id: string) => ({ kind: "installed-app", id }),
    gamePermissionsFor: vi.fn(async () => held.value)
}));
vi.mock("@/lib/apps/install-service", () => ({
    getInstalledApp: vi.fn(async () => ({
        id: "install-1",
        catalogId: "minecraft",
        name: "Test server",
        applicationId: "app-1"
    })),
    getInstalledAppSettings: vi.fn(async () =>
        [
            "TYPE",
            "VERSION",
            "DIFFICULTY",
            "MODE",
            "MAX_PLAYERS",
            "MEMORY",
            "MOTD",
            "RCON_PASSWORD",
            "OPS",
            "MODRINTH_PROJECTS"
        ].map((key) => ({ key, label: key, value: `${key.toLowerCase()}-value` }))
    )
}));
vi.mock("@/lib/app-extensions/registry", () => ({ installedPanelSlot: vi.fn(async () => null) }));
vi.mock("@/components/i18n/messages", () => ({ Messages: () => null }));
vi.mock("@/app/(app)/apps/installed/[id]/installed-app-dashboard", () => ({
    InstalledAppDashboard: () => null
}));

const { default: InstalledAppPage } = await import(
    "@/app/(app)/apps/installed/[id]/[[...tab]]/page"
);

/** The keys the page hands the dashboard, for a viewer holding `held.value`. */
async function sentKeys(): Promise<string[]> {
    const page = (await InstalledAppPage({
        params: Promise.resolve({ id: "install-1" })
    })) as ReactElement<{ children: ReactElement<{ settings: { key: string }[] }> }>;
    return page.props.children.props.settings.map((setting) => setting.key);
}

describe("the settings an installed game server's page sends", () => {
    beforeEach(() => {
        held.value = [];
    });

    it("sends a games.read viewer only what the overview shows", async () => {
        held.value = ["games.read"];
        expect(await sentKeys()).toEqual([
            "TYPE",
            "VERSION",
            "DIFFICULTY",
            "MODE",
            "MAX_PLAYERS",
            "MEMORY",
            "MOTD"
        ]);
    });

    it("sends a games.manage viewer every setting", async () => {
        held.value = ["games.read", "games.manage"];
        expect(await sentKeys()).toEqual([
            "TYPE",
            "VERSION",
            "DIFFICULTY",
            "MODE",
            "MAX_PLAYERS",
            "MEMORY",
            "MOTD",
            "RCON_PASSWORD",
            "OPS",
            "MODRINTH_PROJECTS"
        ]);
    });
});
