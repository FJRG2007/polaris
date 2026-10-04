/**
 * The Drive tools, called the way an MCP client calls them.
 *
 * Drive's authorization and its drivers are tested on their own; what is pinned
 * here is the boundary: a key without the scope is refused before a storage is
 * opened, every path is authorized as the key's own account before it is read,
 * a path that climbs out or into Polaris's own folder never reaches the driver,
 * a link needs a key that may read as well as share, and nothing about a
 * storage's configuration is handed to the model.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
    class DriveAccessError extends Error {}
    class DriveLockedError extends Error {}
    class SmbShareRequiredError extends Error {}
    const driver = { list: vi.fn(), stat: vi.fn(), dispose: vi.fn() };
    return {
        DriveAccessError,
        DriveLockedError,
        SmbShareRequiredError,
        driver,
        authorizeDrive: vi.fn(),
        drivePathFilter: vi.fn(),
        getDriverForConnection: vi.fn(),
        listAccessibleConnections: vi.fn(),
        createShare: vi.fn(),
        recordAudit: vi.fn()
    };
});

vi.mock("@polaris/db", () => ({ prisma: {} }));
// The rest of the catalogue loads with these tools; its operations are not under test here.
vi.mock("@/lib/deploy/api/surface", () => ({}));
vi.mock("@/lib/drive-authz", () => ({
    DriveAccessError: mocks.DriveAccessError,
    DriveLockedError: mocks.DriveLockedError,
    authorizeDrive: mocks.authorizeDrive,
    drivePathFilter: mocks.drivePathFilter
}));
vi.mock("@/lib/storage-service", () => ({
    SmbShareRequiredError: mocks.SmbShareRequiredError,
    getDriverForConnection: mocks.getDriverForConnection,
    listAccessibleConnections: mocks.listAccessibleConnections
}));
vi.mock("@/lib/workspace-scope", () => ({ scopeOrgIdFor: async () => null }));
vi.mock("@/lib/share-service", () => ({ createShare: mocks.createShare }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: mocks.recordAudit }));
vi.mock("@/lib/domain-service", () => ({ sharingBaseUrl: async () => "https://share.example.test" }));
vi.mock("@/lib/public-reach", () => ({ ensureShareReachability: async () => undefined }));

const { DRIVE_TOOLS } = await import("@/lib/mcp/tools/drive");
const { MCP_TOOLS } = await import("@/lib/mcp/tools");
const { handleMcpMessage } = await import("@/lib/mcp/protocol");

const SERVER = { name: "polaris", version: "1", instructions: "" };

type ToolResult = { content: { text: string }[]; isError?: boolean; structuredContent?: any };

function call(name: string, args: Record<string, unknown>, scopes: string[] = ["drive.read"]) {
    return handleMcpMessage(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        MCP_TOOLS,
        { userId: "user-1", isAdmin: false, scopes: scopes as never, keyId: "key-1" },
        SERVER
    );
}

function entry(name: string, kind: "file" | "dir" = "file") {
    return {
        name,
        path: `docs/${name}`,
        kind,
        size: 1234n,
        modifiedAt: new Date("2026-10-01T00:00:00.000Z")
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizeDrive.mockResolvedValue(undefined);
    mocks.getDriverForConnection.mockResolvedValue(mocks.driver);
    mocks.drivePathFilter.mockResolvedValue(async () => true);
    mocks.driver.dispose.mockResolvedValue(undefined);
});

describe("the drive tools", () => {
    it("are all in the catalogue, reads before the link", () => {
        const names = MCP_TOOLS.map((tool) => tool.name);
        for (const tool of DRIVE_TOOLS) expect(names).toContain(tool.name);
        expect(DRIVE_TOOLS.map((tool) => tool.scope)).toEqual([
            "drive.read",
            "drive.read",
            "drive.read",
            "shares.create"
        ]);
        expect(DRIVE_TOOLS.map((tool) => tool.readOnly)).toEqual([true, true, true, false]);
    });

    it("offer no way to read a file's bytes or change one", () => {
        expect(DRIVE_TOOLS.some((tool) => /read_file|download|content|delete|upload|rename|move/.test(tool.name))).toBe(
            false
        );
    });

    it("refuse a key without drive.read before opening anything", async () => {
        const result = (await call("drive_list", { source: "c1" }, ["notes.use"]))?.result as ToolResult;
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("drive.read");
        expect(mocks.authorizeDrive).not.toHaveBeenCalled();
    });

    it("refuse a link to a key that may share but not read", async () => {
        const result = (await call("drive_share_create", { source: "c1", path: "docs/a.pdf" }, ["shares.create"]))
            ?.result as ToolResult;
        expect(result.isError).toBe(true);
        expect(mocks.authorizeDrive).not.toHaveBeenCalled();
        expect(mocks.createShare).not.toHaveBeenCalled();
    });

    it("never hand the driver a path outside the storage or inside Polaris's own folder", async () => {
        for (const path of ["../../etc", ".polaris", ".polaris/trash/x"]) {
            const result = (await call("drive_list", { source: "c1", path }))?.result as ToolResult;
            expect(result.isError, path).toBe(true);
        }
        expect(mocks.authorizeDrive).not.toHaveBeenCalled();
        expect(mocks.getDriverForConnection).not.toHaveBeenCalled();
    });

    it("reject arguments of the wrong shape", async () => {
        expect((await call("drive_list", { source: "" }))?.error?.code).toBe(-32602);
        expect((await call("drive_list", { source: "c1", limit: 101 }))?.error?.code).toBe(-32602);
        expect((await call("drive_stat", { source: "c1", path: "" }))?.error?.code).toBe(-32602);
    });

    it("say the same thing for a folder that is not there and one that is not theirs", async () => {
        mocks.authorizeDrive.mockRejectedValue(new mocks.DriveAccessError());
        const denied = (await call("drive_list", { source: "c1", path: "hr" }))?.result as ToolResult;
        expect(denied.content[0]?.text).toBe("No such location that this account can open.");
        expect(mocks.getDriverForConnection).not.toHaveBeenCalled();
    });

    it("list one folder as the key's account, folders first, a page at a time", async () => {
        mocks.driver.list.mockResolvedValue({
            entries: [
                entry("b.txt"),
                { ...entry(".polaris", "dir"), path: ".polaris" },
                entry("secret", "dir"),
                entry("a.txt"),
                entry("photos", "dir"),
                ...Array.from({ length: 30 }, (_, index) => entry(`z${String(index).padStart(2, "0")}.txt`))
            ]
        });
        mocks.drivePathFilter.mockResolvedValue(async (path: string) => path !== "docs/secret");

        const result = (await call("drive_list", { source: "c1", path: "docs", limit: 3 }))?.result as ToolResult;
        expect(mocks.authorizeDrive).toHaveBeenCalledWith("user-1", "c1", "docs", "read");
        expect(result.structuredContent.entries.map((row: { name: string }) => row.name)).toEqual([
            "photos",
            "a.txt",
            "b.txt"
        ]);
        expect(result.structuredContent.nextOffset).toBe(3);
        expect(result.structuredContent.entries[1]).toEqual({
            name: "a.txt",
            path: "docs/a.txt",
            kind: "file",
            size: 1234,
            modifiedAt: "2026-10-01T00:00:00.000Z"
        });
        expect(mocks.driver.dispose).toHaveBeenCalled();
    });

    it("name the storages and nothing about how they are reached", async () => {
        mocks.listAccessibleConnections.mockResolvedValue([
            { id: "host:9", name: "Box", kind: "sftp", config: '{"host":"10.0.0.9","password":"hunter2"}' }
        ]);
        const result = (await call("drive_sources", {}))?.result as ToolResult;
        expect(mocks.listAccessibleConnections).toHaveBeenCalledWith("user-1", null);
        expect(result.structuredContent).toEqual({ sources: [{ id: "host:9", name: "Box", kind: "sftp" }] });
        expect(result.content[0]?.text).not.toContain("10.0.0.9");
    });

    it("make a link only after authorizing the path as a download, and record it", async () => {
        mocks.driver.stat.mockResolvedValue(entry("a.pdf"));
        mocks.createShare.mockResolvedValue({ id: "share-1", token: "tok" });
        const result = (
            await call("drive_share_create", { source: "c1", path: "docs/a.pdf", expiresInDays: 7 }, [
                "drive.read",
                "shares.create"
            ])
        )?.result as ToolResult;
        expect(mocks.authorizeDrive).toHaveBeenCalledWith("user-1", "c1", "docs/a.pdf", "download");
        expect(mocks.createShare).toHaveBeenCalledWith(
            "user-1",
            expect.objectContaining({ connectionId: "c1", path: "docs/a.pdf", kind: "public", allowUpload: false })
        );
        expect(mocks.recordAudit).toHaveBeenCalledWith(
            expect.objectContaining({ actorId: "user-1", action: "share.create", targetId: "share-1" })
        );
        expect(result.structuredContent.url).toBe("https://share.example.test/s/tok");
        expect(result.structuredContent.expiresAt).not.toBeNull();
    });

    it("refuse a locked folder rather than asking for its password", async () => {
        mocks.authorizeDrive.mockRejectedValue(new mocks.DriveLockedError());
        const result = (
            await call("drive_share_create", { source: "c1", path: "vault/x" }, ["drive.read", "shares.create"])
        )?.result as ToolResult;
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("locked");
        expect(mocks.createShare).not.toHaveBeenCalled();
    });
});
