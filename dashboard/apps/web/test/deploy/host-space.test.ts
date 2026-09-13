/**
 * Reading how much room the container store is taking, and giving some back.
 *
 * The reason any of this exists: a deploy stopped with a rename it could not
 * finish inside the image store, ending "no such file or directory". The disk
 * was at 97% and the layer had nowhere to land. Nothing said so, and there was
 * nothing an operator could do about it from Polaris.
 *
 * Two rules matter more than the arithmetic. Volumes are never counted as
 * reclaimable, because every byte of them is somebody's save file or database
 * and they do not come back. And a daemon that cannot answer has to read as
 * "cannot say" rather than as "this machine is holding nothing" - one of those
 * draws a panel full of zeroes about a disk that is actually full.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** What the daemon answers, which each test sets. */
let replies: Record<string, { status: number; body: string }> = {};
const asked: { method: string; path: string }[] = [];

vi.mock("@polaris/hostd-client", () => ({
    HostdClient: class {
        async dockerRequest(method: string, path: string) {
            asked.push({ method, path });
            const reply = replies[path];
            if (!reply) throw new Error("not reachable");
            return reply;
        }
    }
}));

const { hostSpace, reclaimHostSpace, unusedImagesPrunePath } = await import(
    "@/lib/deploy/host-space"
);

const GB = 1024 * 1024 * 1024;

function df(body: unknown) {
    replies["/system/df"] = { status: 200, body: JSON.stringify(body) };
}

beforeEach(() => {
    replies = {};
    asked.length = 0;
});

describe("what the container store is holding", () => {
    it("adds each kind up as the daemon reports it", async () => {
        df({
            Images: [{ Size: 2 * GB, Containers: 1 }],
            Containers: [{ SizeRw: 10 * 1024 * 1024 }],
            Volumes: [{ UsageData: { Size: 28 * GB, RefCount: 1 } }],
            BuildCache: [{ Size: 4 * GB, InUse: true }]
        });
        const space = await hostSpace();
        expect(space?.images).toBe(2 * GB);
        expect(space?.volumes).toBe(28 * GB);
        expect(space?.buildCache).toBe(4 * GB);
        expect(space?.containers).toBe(10 * 1024 * 1024);
    });

    it("counts only what holds nothing anybody wrote as reclaimable", async () => {
        df({
            // On a container, so not reclaimable however large.
            Images: [
                { Size: 5 * GB, Containers: 2 },
                { Size: 1 * GB, Containers: 0 }
            ],
            Volumes: [{ UsageData: { Size: 28 * GB, RefCount: 1 } }],
            BuildCache: [
                { Size: 3 * GB, InUse: false },
                { Size: 2 * GB, InUse: true }
            ]
        });
        const space = await hostSpace();
        // The loose image and the idle cache, and nothing else.
        expect(space?.reclaimable).toBe(4 * GB);
    });

    it("never counts a volume as reclaimable, whatever it is holding", async () => {
        df({ Volumes: [{ UsageData: { Size: 40 * GB, RefCount: 0 } }] });
        // Unreferenced and enormous, and still not this button's to remove.
        expect((await hostSpace())?.reclaimable).toBe(0);
    });

    it("does not offer room a rollback is holding", async () => {
        // A pinned release runs on no container, so the arithmetic would call it
        // loose - and the prune refuses it by its label, so the number would be a
        // promise the button cannot keep.
        df({
            Images: [
                { Size: 2 * GB, Containers: 0, RepoTags: ["polaris-release/orphion-e6ba:cf94f613"] },
                { Size: 1 * GB, Containers: 0, RepoTags: ["mongo:7"] }
            ]
        });
        expect((await hostSpace())?.reclaimable).toBe(1 * GB);
    });

    it("counts an image that has lost its tags", async () => {
        // Untagged is the oldest case of all and the one a prune is for: a layer
        // set no tag points at any more, left by the pull that replaced it.
        df({ Images: [{ Size: 3 * GB, Containers: 0, RepoTags: ["<none>:<none>"] }] });
        expect((await hostSpace())?.reclaimable).toBe(3 * GB);
    });

    it("does not double-count shared build cache", async () => {
        df({ BuildCache: [{ Size: 1 * GB, InUse: false, Shared: true }] });
        expect((await hostSpace())?.reclaimable).toBe(0);
    });

    it("says it cannot tell rather than reporting an empty machine", async () => {
        // No reply at all, a refusal, and a body that is not JSON.
        expect(await hostSpace()).toBeNull();
        replies["/system/df"] = { status: 500, body: "" };
        expect(await hostSpace()).toBeNull();
        replies["/system/df"] = { status: 200, body: "<html>no</html>" };
        expect(await hostSpace()).toBeNull();
    });
});

describe("giving room back", () => {
    it("asks for both kinds and reports what was actually removed", async () => {
        replies["/build/prune"] = { status: 200, body: JSON.stringify({ SpaceReclaimed: 8 * GB }) };
        replies[unusedImagesPrunePath()] = {
            status: 200,
            body: JSON.stringify({ SpaceReclaimed: 2 * GB })
        };
        expect(await reclaimHostSpace()).toBe(10 * GB);
        expect(asked.map((call) => call.path)).toEqual([
            "/build/prune",
            unusedImagesPrunePath()
        ]);
    });

    it("asks for every image no container is on, and never for a pinned release", async () => {
        // The two halves of the filter, and the reason ten gigabytes sat on a
        // full disk being measured as reclaimable and never removed: without
        // `dangling=false` a prune takes only what has lost its tags, and without
        // the label a prune takes the image a rollback needs.
        const path = unusedImagesPrunePath();
        const filters = JSON.parse(decodeURIComponent(path.split("filters=")[1] ?? "{}")) as Record<
            string,
            string[]
        >;
        expect(filters["dangling"]).toEqual(["false"]);
        expect(filters["label!"]).toEqual(["polaris.release"]);
        // No spaces: the daemon's allowlist refuses a path carrying one.
        expect(path).not.toContain(" ");
    });

    it("never asks for a volume to be pruned", async () => {
        replies["/build/prune"] = { status: 200, body: "{}" };
        replies[unusedImagesPrunePath()] = { status: 200, body: "{}" };
        await reclaimHostSpace();
        expect(asked.some((call) => call.path.includes("volume"))).toBe(false);
    });

    it("does the second even when the first frees nothing", async () => {
        // They hold different things, and somebody pressing this once means both.
        replies["/build/prune"] = { status: 200, body: JSON.stringify({ SpaceReclaimed: 0 }) };
        replies[unusedImagesPrunePath()] = {
            status: 200,
            body: JSON.stringify({ SpaceReclaimed: 3 * GB })
        };
        expect(await reclaimHostSpace()).toBe(3 * GB);
    });

    it("says nothing happened when the daemon would not take it", async () => {
        // Distinct from freeing zero bytes: one is a machine that had nothing to
        // give back, the other is a machine that was never asked.
        expect(await reclaimHostSpace()).toBeNull();
    });
});
