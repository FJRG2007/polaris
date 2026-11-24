/**
 * Drive changes made with Polaris out of reach: kept in order, drawn into the
 * folder as they will be, made when Polaris answers, asked again later while
 * it is not there, and shown as not made when it refuses one.
 */

import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DriveEntry } from "@/app/(app)/drive/types";

vi.mock("@/lib/reachability", () => ({
    noteRequestFailure: () => undefined,
    isNetworkFailure: (caught: unknown) => caught instanceof TypeError
}));
vi.mock("@/lib/new-build", () => ({ checkForNewBuild: async () => undefined }));
const replay = vi.fn();
vi.mock("@/app/(app)/drive/offline-actions", () => ({ replayDriveChangeAction: (input: unknown) => replay(input) }));

const { appWrites, dropOfflineStore, offlineStore } = await import("@/lib/offline/app-writes");
const { DRIVE_CHANGE, keepDriveChange, withDriveChanges } = await import("@/app/(app)/drive/offline-changes");

const row = (path: string, kind: DriveEntry["kind"] = "file"): DriveEntry => ({
    name: path.slice(path.lastIndexOf("/") + 1),
    path,
    kind,
    size: "1",
    modifiedAt: "2026-11-24T00:00:00.000Z",
    createdAt: "2026-11-24T00:00:00.000Z"
});

async function drained(): Promise<void> {
    for (let round = 0; round < 3; round += 1) {
        appWrites.flush();
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

const kept = async () => (await appWrites.readAll()).filter((entry) => entry.kind === DRIVE_CHANGE);

beforeEach(async () => {
    await dropOfflineStore();
    offlineStore.setOwner("u1");
    replay.mockReset();
});

describe("a Drive change made offline", () => {
    it("is drawn into the folder as it will be", async () => {
        replay.mockRejectedValue(new TypeError("Failed to fetch"));
        await keepDriveChange({ op: "rename", connectionId: "c1", from: "docs/a.txt", to: "docs/b.txt" });
        await keepDriveChange({ op: "trash", connectionId: "c1", path: "docs/old.txt" });
        await keepDriveChange({ op: "move", connectionId: "c1", from: "docs/plan.pdf", dest: "archive" });
        await keepDriveChange({ op: "mkdir", connectionId: "c1", path: "docs", name: "New" });
        await keepDriveChange({ op: "trash", connectionId: "c2", path: "docs/keep.txt" });
        const changes = await kept();
        expect(replay).not.toHaveBeenCalled();
        expect(changes).toHaveLength(5);
        const docs = withDriveChanges(
            [row("docs/a.txt"), row("docs/old.txt"), row("docs/plan.pdf"), row("docs/keep.txt")],
            "c1",
            "docs",
            changes
        );
        expect(docs.map((one) => one.path).sort()).toEqual(["docs/New", "docs/b.txt", "docs/keep.txt"]);
        expect(docs.find((one) => one.path === "docs/b.txt")?.name).toBe("b.txt");
        const archive = withDriveChanges([], "c1", "archive", changes);
        expect(archive).toEqual([]);
    });

    it("is made in order once Polaris answers", async () => {
        replay.mockRejectedValue(new TypeError("Failed to fetch"));
        await keepDriveChange({ op: "rename", connectionId: "c1", from: "a", to: "b" });
        await keepDriveChange({ op: "trash", connectionId: "c1", path: "b" });
        await drained();
        replay.mockReset();
        replay.mockResolvedValue({});
        await drained();
        expect(await kept()).toHaveLength(0);
        expect(replay.mock.calls.map(([change]) => change.op)).toEqual(["rename", "trash"]);
    });

    it("is shown as not made, the folder as the server has it, when Polaris refuses it", async () => {
        replay.mockResolvedValue({ error: "That name is taken." });
        await keepDriveChange({ op: "rename", connectionId: "c1", from: "a", to: "b" });
        await drained();
        const [entry] = await kept();
        expect(entry?.state).toBe("failed");
        expect(entry?.reason).toBe("That name is taken.");
        expect(withDriveChanges([row("a")], "c1", "", await kept()).map((one) => one.path)).toEqual(["a"]);
    });
});
