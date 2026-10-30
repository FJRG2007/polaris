/**
 * A share link whose `?p` points at something renamed, moved or deleted.
 *
 * Opening `/s/<token>?p=Shared/Ideas/TV/Living Room` after "Living Room" was
 * renamed showed "Link unavailable" for the whole share, although the share
 * itself was fine. The address now lands on the nearest ancestor that still
 * exists inside the share, and says what went missing; only the shared item
 * itself being gone makes the link unavailable. Nothing outside the share is
 * ever stat'ed or named.
 */

import { describe, expect, it } from "vitest";
import { landWithinShare } from "@/lib/share-service";

/** A source that holds exactly these paths (folders unless they have a dot). */
function source(paths: string[]) {
    const statted: string[] = [];
    const stat = async (path: string) => {
        statted.push(path);
        if (!paths.includes(path)) throw new Error("ENOENT");
        return { kind: path.includes(".") ? ("file" as const) : ("dir" as const), size: 7n };
    };
    return { stat, statted };
}

const TREE = [
    "Studio",
    "Studio/Ideas",
    "Studio/Ideas/TV",
    "Studio/Ideas/TV/photo.jpg",
    "Studio/Other"
];

describe("landing a share address", () => {
    it("opens the requested folder when it exists", async () => {
        const { stat } = source(TREE);
        expect(await landWithinShare("Studio/Ideas", "Studio/Ideas/TV", stat)).toEqual({
            path: "Studio/Ideas/TV",
            kind: "dir",
            size: 7n,
            missing: null
        });
    });

    it("lands on the nearest surviving ancestor when the subfolder was renamed", async () => {
        const { stat } = source(TREE);
        const landing = await landWithinShare(
            "Studio/Ideas",
            "Studio/Ideas/TV/Living Room Section",
            stat
        );
        expect(landing?.path).toBe("Studio/Ideas/TV");
        expect(landing?.kind).toBe("dir");
        expect(landing?.missing).toBe("Studio/Ideas/TV/Living Room Section");
    });

    it("climbs as far as the share root, and never above it", async () => {
        const { stat, statted } = source(["Studio", "Studio/Ideas"]);
        const landing = await landWithinShare("Studio/Ideas", "Studio/Ideas/TV/Gone/Deeper", stat);
        expect(landing?.path).toBe("Studio/Ideas");
        expect(landing?.missing).toBe("Studio/Ideas/TV/Gone/Deeper");
        expect(statted.every((path) => path.startsWith("Studio/Ideas"))).toBe(true);
        expect(statted).not.toContain("Studio");
    });

    it("lands on the folder of a previewed file that no longer exists", async () => {
        const { stat } = source(TREE);
        const landing = await landWithinShare("Studio/Ideas", "Studio/Ideas/TV/old.jpg", stat);
        expect(landing?.path).toBe("Studio/Ideas/TV");
        expect(landing?.missing).toBe("Studio/Ideas/TV/old.jpg");
    });

    it("is unavailable only when the shared item itself is gone", async () => {
        const { stat } = source(["Studio"]);
        expect(await landWithinShare("Studio/Ideas", "Studio/Ideas/TV", stat)).toBeNull();
        expect(await landWithinShare("Studio/Ideas", null, stat)).toBeNull();
    });

    it("keeps a request outside the share on the root, and names nothing", async () => {
        const { stat, statted } = source(TREE);
        const landing = await landWithinShare("Studio/Ideas", "Studio/Other", stat);
        expect(landing).toEqual({ path: "Studio/Ideas", kind: "dir", size: 7n, missing: null });
        expect(statted).toEqual(["Studio/Ideas"]);
        const escape = await landWithinShare("Studio/Ideas", "Studio/Ideas/../Other", stat);
        expect(escape?.path).toBe("Studio/Ideas");
        expect(escape?.missing).toBeNull();
    });

    it("works for a share of the whole source", async () => {
        const { stat } = source(["", ...TREE]);
        const landing = await landWithinShare("", "Gone/Folder", stat);
        expect(landing?.path).toBe("");
        expect(landing?.missing).toBe("Gone/Folder");
    });
});
