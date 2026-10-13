/**
 * The dashboard's half of the CRM: a Drive file is pointed at only after the
 * reader's Drive access is checked, never a folder, and a file the reader lost
 * access to drops out of the list; a workflow runs only as an account that may
 * still use the CRM; a workflow's call out goes only through the checked fetch.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const CONNECTION = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const mocks = vi.hoisted(() => ({
    driver: {
        stat: vi.fn(async (): Promise<unknown> => ({ kind: "file" })),
        dispose: vi.fn(async () => undefined)
    },
    requireDriveDriver: vi.fn(),
    mayReadDrive: vi.fn(async () => true),
    sessionCan: vi.fn(async () => true),
    userHasPermission: vi.fn(async () => true),
    follow: vi.fn(
        async (): Promise<unknown> => ({
            status: 202,
            body: { cancel: vi.fn(async () => undefined) }
        })
    ),
    safeUrl: vi.fn((address: string) => (address.startsWith("https://") ? new URL(address) : null)),
    prisma: {
        storageConnection: { findUnique: vi.fn(async () => ({ ownerId: "u1", orgId: null })) },
        user: {
            findFirst: vi.fn(
                async (): Promise<unknown> => ({
                    id: "u1",
                    email: "test@example.invalid",
                    name: "Test User",
                    isAdmin: false
                })
            )
        },
        mailAccount: { findMany: vi.fn(async (): Promise<unknown[]> => [{ id: "acc-1" }]) },
        mailThread: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
        $queryRaw: vi.fn(async (): Promise<unknown[]> => []),
        driveItemMeta: {
            upsert: vi.fn(async () => ({ id: "meta-1" })),
            findMany: vi.fn(async (): Promise<unknown[]> => [])
        }
    }
}));

vi.mock("@polaris/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/drive-authz", () => ({
    requireDriveDriver: mocks.requireDriveDriver,
    mayReadDrive: mocks.mayReadDrive
}));
vi.mock("@polaris/auth", () => ({ userHasPermission: mocks.userHasPermission }));
vi.mock("@/lib/workspace-scope", () => ({ resolveScope: vi.fn() }));
vi.mock("@/lib/session", () => ({ sessionCan: mocks.sessionCan }));
vi.mock("@/lib/safe-fetch", () => ({ follow: mocks.follow, safeUrl: mocks.safeUrl }));
vi.mock("@/lib/orgs/org-service", () => ({
    listOrgMembers: vi.fn(),
    orgCan: vi.fn(),
    resolveOrgAccess: vi.fn()
}));

import {
    crmDriveFileRef,
    crmDriveFiles,
    crmEventsWith,
    crmMailWith,
    crmPostJson,
    crmRunner
} from "@/lib/crm-host";

const actor = { id: "u1", isAdmin: false };

beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireDriveDriver.mockResolvedValue(mocks.driver);
});

describe("crmDriveFileRef", () => {
    it("checks Drive access, then keeps the file's own entry", async () => {
        expect(await crmDriveFileRef(actor, CONNECTION, "/decks/deck.pdf")).toEqual({
            id: "meta-1",
            name: "deck.pdf"
        });
        expect(mocks.requireDriveDriver).toHaveBeenCalledWith(
            "u1",
            CONNECTION,
            "decks/deck.pdf",
            "read",
            {
                skipLock: true
            }
        );
        expect(mocks.prisma.driveItemMeta.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { connectionId_path: { connectionId: CONNECTION, path: "decks/deck.pdf" } }
            })
        );
        expect(mocks.driver.dispose).toHaveBeenCalled();
    });

    it("refuses a file the reader cannot read, a folder, and a path out of the root", async () => {
        mocks.requireDriveDriver.mockRejectedValueOnce(new Error("no"));
        expect(await crmDriveFileRef(actor, CONNECTION, "secret.pdf")).toEqual({ refused: true });
        mocks.driver.stat.mockResolvedValueOnce({ kind: "dir" });
        expect(await crmDriveFileRef(actor, CONNECTION, "decks")).toEqual({ refused: true });
        expect(await crmDriveFileRef(actor, CONNECTION, "../../etc/passwd")).toEqual({
            refused: true
        });
        expect(await crmDriveFileRef(actor, "not-a-uuid", "deck.pdf")).toEqual({ refused: true });
        expect(mocks.prisma.driveItemMeta.upsert).not.toHaveBeenCalled();
    });
});

describe("crmDriveFiles", () => {
    it("names only the files the reader may still read, in the order asked", async () => {
        mocks.prisma.driveItemMeta.findMany.mockResolvedValueOnce([
            { id: "a", connectionId: CONNECTION, path: "x/one.pdf" },
            { id: "b", connectionId: CONNECTION, path: "two.pdf" }
        ]);
        mocks.mayReadDrive.mockImplementation(async (...args: unknown[]) => args[2] !== "two.pdf");
        expect(await crmDriveFiles(actor, ["b", "a", "gone"])).toEqual([
            {
                id: "a",
                name: "one.pdf",
                href: `/drive/open?c=${CONNECTION}&p=x%2Fone.pdf`
            }
        ]);
    });
});

describe("crmRunner", () => {
    const RUNNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    it("is an account that is not banned or switched off and may use the CRM", async () => {
        expect(await crmRunner(RUNNER)).toMatchObject({ id: "u1", sessionId: "" });
        expect(mocks.prisma.user.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: RUNNER, bannedAt: null, disabledAt: null } })
        );
        expect(mocks.sessionCan).toHaveBeenCalledWith(expect.anything(), "crm.use");
    });

    it("is nobody for a gone account, one without the CRM, or no id", async () => {
        mocks.prisma.user.findFirst.mockResolvedValueOnce(null);
        expect(await crmRunner(RUNNER)).toBeNull();
        mocks.sessionCan.mockResolvedValueOnce(false);
        expect(await crmRunner(RUNNER)).toBeNull();
        expect(await crmRunner("not-an-id")).toBeNull();
    });
});

describe("crmPostJson", () => {
    const URL = "https://hooks.example.invalid/crm";

    it("posts JSON through the checked fetch and answers the status, leaving the body unread", async () => {
        expect(await crmPostJson(URL, '{"a":1}')).toEqual({ status: 202 });
        expect(mocks.follow).toHaveBeenCalledWith(new globalThis.URL(URL), "application/json", {
            contentType: "application/json",
            body: '{"a":1}'
        });
    });

    it("refuses an address it may not reach, and says when nothing answered", async () => {
        expect(await crmPostJson("http://169.254.169.254/", "{}")).toEqual({ failed: "address" });
        mocks.follow.mockResolvedValueOnce(null);
        expect(await crmPostJson(URL, "{}")).toEqual({ failed: "unreachable" });
    });
});

describe("mail and events with a record's people", () => {
    it("reads only the reader's own mailboxes, matched by lowercased address", async () => {
        mocks.prisma.mailThread.findMany.mockResolvedValueOnce([
            {
                id: "t1",
                subject: "Renewal",
                snippet: "See you then",
                participants: [{ name: "Fixture Contact", address: "contact@example.test" }],
                messageCount: 3,
                lastMessageAt: new Date("2026-10-01T10:00:00.000Z")
            }
        ]);
        const found = await crmMailWith(actor, [" Contact@Example.test ", "not-an-address"], 20);
        expect(mocks.prisma.mailAccount.findMany).toHaveBeenCalledWith({
            where: { userId: "u1" },
            select: { id: true }
        });
        expect(mocks.prisma.mailThread.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    accountId: { in: ["acc-1"] },
                    OR: [
                        {
                            participants: {
                                array_contains: [{ address: "contact@example.test" }]
                            }
                        }
                    ]
                }),
                orderBy: { lastMessageAt: "desc" },
                take: 20
            })
        );
        expect(found).toEqual([
            expect.objectContaining({
                id: "t1",
                messageCount: 3,
                lastMessageAt: "2026-10-01T10:00:00.000Z",
                href: "/mail/t/t1"
            })
        ]);
    });

    it("answers null without Mail or Calendar, and asks nothing without addresses", async () => {
        mocks.userHasPermission.mockResolvedValueOnce(false);
        expect(await crmMailWith(actor, ["contact@example.test"], 20)).toBeNull();
        mocks.userHasPermission.mockResolvedValueOnce(false);
        expect(await crmEventsWith(actor, ["contact@example.test"], 20)).toBeNull();
        expect(await crmMailWith(actor, [], 20)).toEqual([]);
        expect(await crmEventsWith(actor, [""], 20)).toEqual([]);
        expect(mocks.prisma.mailThread.findMany).not.toHaveBeenCalled();
        expect(mocks.prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it("finds events by an escaped mailto pattern on the reader's own calendars", async () => {
        mocks.prisma.$queryRaw.mockResolvedValueOnce([
            {
                id: "e1",
                summary: "Demo",
                location: "",
                startsAt: new Date("2026-10-02T09:00:00.000Z"),
                endsAt: null,
                allDay: false
            }
        ]);
        const found = await crmEventsWith(actor, ["first_last@example.test"], 20);
        const [, ...values] = mocks.prisma.$queryRaw.mock.calls[0] as unknown as unknown[];
        expect(values).toContain("u1");
        expect(values).toContainEqual(["%mailto:first\_last@example.test%"]);
        expect(found).toEqual([
            expect.objectContaining({
                id: "e1",
                startsAt: "2026-10-02T09:00:00.000Z",
                href: "/calendar/e/e1"
            })
        ]);
    });
});
