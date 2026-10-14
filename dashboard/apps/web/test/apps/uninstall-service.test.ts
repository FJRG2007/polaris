/**
 * `uninstallApp` carries out the plan: with the data kept it soft-removes the
 * row and clears its secret; with the data deleted it hands the choice to
 * Deploy, purges every install-scoped table in one transaction and deletes the
 * row. The database and Deploy are fakes - no container is touched here.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { INSTALL_SCOPED_MODELS } from "@/lib/apps/uninstall-plan";

const scoped = Object.fromEntries(
    INSTALL_SCOPED_MODELS.map((model) => [model, { deleteMany: vi.fn(async () => ({ count: 0 })) }])
);
const db = {
    installedApp: {
        findFirst: vi.fn(),
        findMany: vi.fn(async () => []),
        updateMany: vi.fn(async () => ({ count: 1 })),
        deleteMany: vi.fn(async () => ({ count: 1 }))
    },
    // The backing application still exists until Deploy deletes it.
    application: {
        findUnique: vi.fn(async (args: { where: { id: string } }) => ({ id: args.where.id }))
    },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    ...scoped
};
vi.mock("@polaris/db", () => ({ prisma: db }));

const deleteApplication = vi.fn(async () => undefined);
vi.mock("@/lib/deploy-service", () => ({
    deleteApplication,
    createApplication: vi.fn(),
    createProject: vi.fn(),
    deployApplication: vi.fn()
}));
const clearResourceGrants = vi.fn(async () => undefined);
vi.mock("@polaris/auth", () => ({ clearResourceGrants }));
const reconcilePrivateNetworks = vi.fn(async () => null);
vi.mock("@/lib/deploy/service-networks", () => ({ reconcilePrivateNetworks }));
const pauseOwnedServices = vi.fn(async () => undefined);
vi.mock("@/lib/apps/app-lifecycle", () => ({
    appUninstallRefusal: vi.fn(async () => null),
    pauseOwnedServices,
    resumeOwnedServices: vi.fn()
}));
vi.mock("@/lib/mail-server/app-install", () => ({
    MAIL_SERVER_APP: "mail-server",
    uninstallRefusal: vi.fn(async () => null)
}));
const appUninstalled = vi.fn(async () => undefined);
vi.mock("@/lib/app-bundles/lifecycle", () => ({ appUninstalled, appInstalled: vi.fn() }));
vi.mock("@/lib/access-live", () => ({ publishAccessChange: vi.fn() }));
vi.mock("@/lib/messaging/bridge-endpoint", () => ({ invalidateBridgeCache: vi.fn() }));
vi.mock("@/lib/apps/install-presence", () => ({ invalidateInstallPresence: vi.fn() }));
const purgeInstallFiles = vi.fn(async () => undefined);
vi.mock("@/lib/app-extensions/registry", async (importOriginal) => ({
    ...(await importOriginal<object>()),
    purgeInstallFiles
}));

const { forgetRemovedInstallSecrets, uninstallApp } = await import("@/lib/apps/install-service");
const { UninstallIncompleteError } = await import("@/lib/apps/uninstall-plan");

const ROW = {
    id: "00000000-0000-7000-8000-000000000001",
    ownerId: "00000000-0000-7000-8000-0000000000aa",
    catalogId: "minecraft",
    applicationId: "00000000-0000-7000-8000-0000000000bb"
};

beforeEach(() => {
    vi.clearAllMocks();
    // A lookup by id finds the install; "is anybody still using it" finds nobody.
    db.installedApp.findFirst.mockImplementation((async (args: { where: { id?: string } }) =>
        args.where.id === ROW.id ? ROW : null) as never);
});

describe("uninstallApp", () => {
    it("keeps the data by default: soft-removes the row and clears its secret", async () => {
        await uninstallApp(ROW.ownerId, ROW.id);
        expect(deleteApplication).toHaveBeenCalledWith(ROW.applicationId, ROW.ownerId, {
            deleteData: false,
            strict: true
        });
        expect(db.installedApp.updateMany).toHaveBeenCalledWith({
            where: { id: { in: [ROW.id] } },
            data: { status: "removed", encryptedSecret: null, secretNonce: null, secretKeyId: null }
        });
        expect(db.installedApp.deleteMany).not.toHaveBeenCalled();
        expect(db.$transaction).not.toHaveBeenCalled();
        expect(purgeInstallFiles).not.toHaveBeenCalled();
        expect(pauseOwnedServices).toHaveBeenCalledWith("minecraft");
        expect(appUninstalled).toHaveBeenCalledWith("minecraft");
    });

    it("with the data deleted: purges every install-scoped table, then the row", async () => {
        await uninstallApp(ROW.ownerId, ROW.id, { deleteData: true });
        expect(deleteApplication).toHaveBeenCalledWith(ROW.applicationId, ROW.ownerId, {
            deleteData: true,
            strict: true
        });
        expect(db.$transaction).toHaveBeenCalledTimes(1);
        // The files go while the rows that find them still exist.
        expect(purgeInstallFiles).toHaveBeenCalledWith(ROW.id);
        expect(purgeInstallFiles.mock.invocationCallOrder[0]).toBeLessThan(
            db.$transaction.mock.invocationCallOrder[0]!
        );
        for (const model of INSTALL_SCOPED_MODELS) {
            expect(scoped[model]!.deleteMany, model).toHaveBeenCalledWith({
                where: { installedAppId: ROW.id }
            });
        }
        expect(db.installedApp.deleteMany).toHaveBeenCalledWith({
            where: { id: { in: [ROW.id] } }
        });
        expect(db.installedApp.updateMany).not.toHaveBeenCalled();
        expect(pauseOwnedServices).not.toHaveBeenCalled();
    });

    it("stops before anything else goes when an install's files could not be removed", async () => {
        const { InstallFilesLeftError } = await import("@/lib/app-extensions/registry");
        purgeInstallFiles.mockRejectedValueOnce(new InstallFilesLeftError(["home"]) as never);
        await expect(
            uninstallApp(ROW.ownerId, ROW.id, { deleteData: true })
        ).rejects.toBeInstanceOf(InstallFilesLeftError);
        expect(deleteApplication).not.toHaveBeenCalled();
        expect(db.$transaction).not.toHaveBeenCalled();
        expect(db.installedApp.deleteMany).not.toHaveBeenCalled();
        expect(db.installedApp.updateMany).not.toHaveBeenCalled();
    });

    it("uninstalls a builtin app's helpers with their data when the data goes", async () => {
        const home = { ...ROW, catalogId: "home", applicationId: null };
        const helper = { id: "00000000-0000-7000-8000-000000000002", ownerId: ROW.ownerId };
        db.installedApp.findFirst.mockImplementation((async (args: { where: { id?: string } }) =>
            args.where.id === home.id
                ? home
                : args.where.id === helper.id
                  ? { ...helper, catalogId: "camera-hub", applicationId: "app-helper" }
                  : null) as never);
        // Nobody has Places any more; the camera relay is still there to go.
        db.installedApp.findMany.mockImplementation((async (args: {
            where: { catalogId?: { in?: string[] } };
            select?: { ownerId?: boolean };
        }) => (args.select?.ownerId ? [helper] : [])) as never);
        await uninstallApp(home.ownerId, home.id, { deleteData: true });
        expect(deleteApplication).toHaveBeenCalledWith("app-helper", ROW.ownerId, {
            deleteData: true,
            strict: true
        });
        expect(db.installedApp.deleteMany).toHaveBeenCalledWith({
            where: { id: { in: [helper.id] } }
        });
    });

    it("refuses an install that is not the caller's", async () => {
        db.installedApp.findFirst.mockResolvedValue(null as never);
        await expect(uninstallApp(ROW.ownerId, ROW.id)).rejects.toThrow("not found");
        expect(deleteApplication).not.toHaveBeenCalled();
    });

    it("clears the access people were given, and settles the networks it left", async () => {
        await uninstallApp(ROW.ownerId, ROW.id);
        expect(clearResourceGrants).toHaveBeenCalledWith({ kind: "install", id: ROW.id });
        expect(reconcilePrivateNetworks).toHaveBeenCalledTimes(1);
    });

    it("stops with what is left when its containers cannot come down, and touches no row", async () => {
        deleteApplication.mockRejectedValueOnce(new Error("server unreachable") as never);
        const failure = await uninstallApp(ROW.ownerId, ROW.id, { deleteData: true }).catch(
            (error: unknown) => error
        );
        expect(failure).toBeInstanceOf(UninstallIncompleteError);
        expect((failure as InstanceType<typeof UninstallIncompleteError>).phase).toBe("containers");
        expect((failure as InstanceType<typeof UninstallIncompleteError>).left).toContain(
            "install-row"
        );
        expect(db.installedApp.deleteMany).not.toHaveBeenCalled();
        expect(db.installedApp.updateMany).not.toHaveBeenCalled();
        expect(db.$transaction).not.toHaveBeenCalled();
        expect(clearResourceGrants).not.toHaveBeenCalled();
    });

    it("finishes on a retry, and a second run over an app Deploy already removed is a no-op there", async () => {
        deleteApplication.mockRejectedValueOnce(new Error("server unreachable") as never);
        await uninstallApp(ROW.ownerId, ROW.id, { deleteData: true }).catch(() => undefined);
        await uninstallApp(ROW.ownerId, ROW.id, { deleteData: true });
        expect(db.installedApp.deleteMany).toHaveBeenCalledWith({
            where: { id: { in: [ROW.id] } }
        });
        // The application is gone now: a third run does not ask Deploy again.
        db.application.findUnique.mockResolvedValueOnce(null as never);
        deleteApplication.mockClear();
        await uninstallApp(ROW.ownerId, ROW.id, { deleteData: true });
        expect(deleteApplication).not.toHaveBeenCalled();
    });
});

describe("removed installs from before an uninstall cleared their secret", () => {
    it("lose the credential, and only removed ones are touched", async () => {
        db.installedApp.updateMany.mockResolvedValueOnce({ count: 3 } as never);
        expect(await forgetRemovedInstallSecrets()).toEqual({ cleared: 3 });
        expect(db.installedApp.updateMany).toHaveBeenLastCalledWith({
            where: { status: "removed", NOT: { encryptedSecret: null } },
            data: { encryptedSecret: null, secretNonce: null, secretKeyId: null }
        });
    });
});
