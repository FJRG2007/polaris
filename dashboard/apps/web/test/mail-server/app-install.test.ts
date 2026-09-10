/**
 * The mail server as a marketplace app: when it counts as installed, and when it
 * may be taken away.
 *
 * Three rules are protected. An install row makes it installed, and so does a
 * mail server existing - an instance that ran one before it was an app must not
 * lose its screens on the update that made it installable, and the first screen
 * opened adopts a row for it. Uninstalling is refused while any mail server is
 * set up, whichever door the uninstall came through. And installing runs
 * nothing: one row, no service, no image.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface InstallRow {
    id: string;
    catalogId: string;
    ownerId: string;
    name: string;
    status: string;
    applicationId: string | null;
    createdAt: Date;
}

let installs: InstallRow[];
let servers: { id: string; ownerId: string; createdAt: Date }[];
let applicationsCreated: number;

type Where = Record<string, unknown>;

/** Whether a row matches the handful of filter shapes these modules write. */
function matches(row: Record<string, unknown>, where: Where = {}): boolean {
    return Object.entries(where).every(([key, wanted]) => {
        const value = row[key];
        if (wanted && typeof wanted === "object" && !(wanted instanceof Date)) {
            const filter = wanted as { not?: unknown; in?: unknown[] };
            if ("not" in filter) return value !== filter.not;
            if ("in" in filter) return (filter.in ?? []).includes(value);
        }
        return value === wanted;
    });
}

function oldestFirst<T extends { createdAt: Date }>(rows: T[]): T[] {
    return [...rows].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
}

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findFirst: async ({ where }: { where: Where }) =>
                oldestFirst(installs).find((row) => matches(row as never, where)) ?? null,
            findMany: async ({ where }: { where: Where }) => installs.filter((row) => matches(row as never, where)),
            create: async ({ data }: { data: Partial<InstallRow> }) => {
                const row: InstallRow = {
                    id: `install-${installs.length + 1}`,
                    catalogId: "",
                    ownerId: "",
                    name: "",
                    status: "installing",
                    applicationId: null,
                    createdAt: new Date(Date.UTC(2026, 8, installs.length + 1)),
                    ...data
                };
                installs.push(row);
                return row;
            },
            update: async ({ where, data }: { where: { id: string }; data: Partial<InstallRow> }) => {
                const row = installs.find((entry) => entry.id === where.id);
                if (row) Object.assign(row, data);
                return row;
            },
            updateMany: async ({ where, data }: { where: Where; data: Partial<InstallRow> }) => {
                const hit = installs.filter((row) => matches(row as never, where));
                for (const row of hit) Object.assign(row, data);
                return { count: hit.length };
            }
        },
        mailServer: {
            findFirst: async () => oldestFirst(servers)[0] ?? null,
            count: async () => servers.length
        },
        application: {
            create: async () => {
                applicationsCreated += 1;
                return { id: "never" };
            }
        }
    }
}));

const appInstall = await import("@/lib/mail-server/app-install");
const presence = await import("@/lib/apps/install-presence");
const service = await import("@/lib/apps/install-service");
const { APP_SECTIONS } = await import("@/lib/apps");
const { appProvenance } = await import("@/lib/apps/provenance");
const { findApp, installableApps, isInstallable } = await import("@/lib/apps/catalog");

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

function install(ownerId: string, status = "running", catalogId = appInstall.MAIL_SERVER_APP): InstallRow {
    const row: InstallRow = {
        id: `install-${installs.length + 1}`,
        catalogId,
        ownerId,
        name: "Mail server",
        status,
        applicationId: null,
        createdAt: new Date(Date.UTC(2026, 0, installs.length + 1))
    };
    installs.push(row);
    return row;
}

function server(ownerId: string, day: number): void {
    servers.push({ id: `server-${servers.length + 1}`, ownerId, createdAt: new Date(Date.UTC(2026, 0, day)) });
}

beforeEach(() => {
    installs = [];
    servers = [];
    applicationsCreated = 0;
    presence.invalidateInstallPresence();
});

describe("the app in the catalog", () => {
    const manifest = findApp(appInstall.MAIL_SERVER_APP);

    it("is one id everywhere it is named", () => {
        expect(manifest?.id).toBe("mail-server");
        const section = APP_SECTIONS.apps?.find((entry) => entry.href === "/apps/mail-server");
        expect(section?.requiresApp).toBe(appInstall.MAIL_SERVER_APP);
        // The app keeps its own permission; installing is a separate grant.
        expect(section?.needs).toBe("mailserver.manage");
    });

    it("is offered in the marketplace, by Polaris, and installs nothing", () => {
        expect(manifest).toBeDefined();
        if (!manifest) return;
        expect(installableApps().map((app) => app.id)).toContain("mail-server");
        expect(isInstallable(manifest)).toBe(true);
        expect(manifest).toMatchObject({
            installMethod: "builtin",
            singleton: true,
            instanceWide: true,
            opensAt: "/apps/mail-server"
        });
        // No image and no ports of its own: the engine arrives with a server.
        expect(manifest.template).toBeUndefined();
        expect(appProvenance(manifest)).toMatchObject({ developer: "Polaris", firstParty: true });
    });

    it("says what it gives and what a server costs", () => {
        const text = manifest?.description ?? "";
        for (const word of ["SPF", "DKIM", "DMARC", "mailboxes", "aliases"]) expect(text).toContain(word);
        expect(text).toContain("ports 25, 465, 587, 993 and 4190");
    });
});

describe("whether it is installed", () => {
    it("is not, on a Polaris that never had it", async () => {
        expect(await appInstall.mailServerAppInstalled()).toBe(false);
    });

    it("is, once installed", async () => {
        install(ALICE);
        expect(await appInstall.mailServerAppInstalled()).toBe(true);
    });

    it("is not, once uninstalled", async () => {
        install(ALICE, "removed");
        expect(await appInstall.mailServerAppInstalled()).toBe(false);
    });

    it("is, with no install row, where a mail server already exists", async () => {
        // An instance that ran one before it was an app.
        server(ALICE, 1);
        expect(await appInstall.mailServerAppInstalled()).toBe(true);
    });

    it("is not implied for any other app by a mail server", async () => {
        server(ALICE, 1);
        expect(await presence.isAppInstalled("tools")).toBe(false);
    });
});

describe("adopting an install for an instance that already runs one", () => {
    it("records one against whoever set the first server up", async () => {
        server(BOB, 5);
        server(ALICE, 1);
        const id = await appInstall.adoptMailServerApp();
        expect(id).not.toBeNull();
        expect(installs).toHaveLength(1);
        expect(installs[0]).toMatchObject({ id, catalogId: "mail-server", ownerId: ALICE, status: "running" });
    });

    it("does nothing a second time", async () => {
        server(ALICE, 1);
        const first = await appInstall.adoptMailServerApp();
        expect(await appInstall.adoptMailServerApp()).toBe(first);
        expect(installs).toHaveLength(1);
    });

    it("answers the existing install without writing", async () => {
        const row = install(BOB);
        expect(await appInstall.adoptMailServerApp()).toBe(row.id);
        expect(installs).toHaveLength(1);
    });

    it("adopts nothing where there is nothing to adopt", async () => {
        expect(await appInstall.adoptMailServerApp()).toBeNull();
        expect(installs).toHaveLength(0);
    });

    it("keeps the app once the last server is removed after adoption", async () => {
        server(ALICE, 1);
        await appInstall.adoptMailServerApp();
        servers = [];
        presence.invalidateInstallPresence();
        expect(await appInstall.mailServerAppInstalled()).toBe(true);
    });
});

describe("uninstalling", () => {
    it("is refused while a mail server is set up, and says to remove it first", async () => {
        install(ALICE);
        server(ALICE, 1);
        await expect(appInstall.uninstallMailServerApp({ id: ALICE, isAdmin: true })).rejects.toThrow(
            "A mail server is still set up here. Remove it first, then uninstall Mail server."
        );
        server(BOB, 2);
        await expect(appInstall.uninstallMailServerApp({ id: ALICE, isAdmin: true })).rejects.toThrow(
            "2 mail servers are still set up here. Remove them first"
        );
        expect(installs[0]?.status).toBe("running");
    });

    it("is left to whoever installed it or an administrator", async () => {
        install(ALICE);
        await expect(appInstall.uninstallMailServerApp({ id: BOB, isAdmin: false })).rejects.toBeInstanceOf(
            appInstall.MailServerAppRefusal
        );
        expect(await appInstall.uninstallMailServerApp({ id: BOB, isAdmin: true })).toEqual(["install-1"]);
    });

    it("removes every copy, and the app is gone at once", async () => {
        install(ALICE);
        install(BOB);
        expect(await appInstall.mailServerAppInstalled()).toBe(true);
        await appInstall.uninstallMailServerApp({ id: ALICE, isAdmin: false });
        expect(installs.map((row) => row.status)).toEqual(["removed", "removed"]);
        // Not at the end of the presence cache's window.
        expect(await appInstall.mailServerAppInstalled()).toBe(false);
    });

    it("says so when there is nothing to uninstall", async () => {
        await expect(appInstall.uninstallMailServerApp({ id: ALICE, isAdmin: true })).rejects.toThrow(
            "Mail server is not installed."
        );
    });

    it("is refused through the generic uninstall as well", async () => {
        const row = install(ALICE);
        server(ALICE, 1);
        await expect(service.uninstallApp(ALICE, row.id)).rejects.toThrow("A mail server is still set up here.");
        expect(row.status).toBe("running");
        servers = [];
        await service.uninstallApp(ALICE, row.id);
        expect(row.status).toBe("removed");
    });
});

describe("installing", () => {
    const input = { catalogId: "mail-server", name: "Mail server", serverId: "local", storage: [], env: [] };

    it("records the install and runs nothing", async () => {
        const result = await service.installApp(ALICE, ALICE, input);
        expect(result.applicationId).toBeNull();
        expect(applicationsCreated).toBe(0);
        expect(installs).toHaveLength(1);
        expect(installs[0]).toMatchObject({ catalogId: "mail-server", ownerId: ALICE, status: "running" });
        expect(await appInstall.mailServerAppInstalled()).toBe(true);
    });

    it("is one install for the whole Polaris, whoever asks second", async () => {
        await service.installApp(ALICE, ALICE, input);
        await expect(service.installApp(BOB, BOB, input)).rejects.toThrow("This app is already installed");
        expect(installs).toHaveLength(1);
        expect(await service.instanceWideInstallIds()).toEqual(["install-1"]);
    });
});
