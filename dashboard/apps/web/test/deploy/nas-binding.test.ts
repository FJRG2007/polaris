/**
 * Where a running service's NAS volumes really are, read from its own mount table:
 * on the share, on a dead mount, or in a folder on the machine's disk. Only the
 * last two need a restart.
 */

import { describe, expect, it } from "vitest";
import { boundToShare, mountTypes, nasBinding } from "@/lib/deploy/nas-binding";

const TABLE = [
    "22 1 0:31 / / rw,relatime - overlay overlay rw",
    "40 22 0:52 /proj/uploads /data/uploads rw,relatime - cifs //nas/share rw,mfsymlinks",
    "41 22 0:52 /proj/secrets /run/my\\040secrets rw,relatime - cifs //nas/share rw",
    "42 22 0:53 /export/x /srv rw - nfs4 nas:/export rw",
    "43 22 8:1 /var/lib/docker/volumes/x /cache rw - ext4 /dev/sda1 rw"
].join("\n");

function ports(answers: Record<string, { code: number; output: string } | Error>) {
    return {
        runIn: async (_container: string, argv: readonly string[]) => {
            const answer = answers[argv[0]!];
            if (!answer || answer instanceof Error) throw answer ?? new Error("no such tool");
            return answer;
        }
    };
}

describe("mountTypes", () => {
    it("reads the filesystem at each exact path, spaces and trailing slashes included", () => {
        const types = mountTypes(TABLE, [
            "/data/uploads/",
            "/run/my secrets",
            "/srv",
            "/cache",
            "/data"
        ]);
        expect(Object.fromEntries(types)).toEqual({
            "/data/uploads": "cifs",
            "/run/my secrets": "cifs",
            "/srv": "nfs4",
            "/cache": "ext4",
            // A path with nothing mounted at it is the container's own disk.
            "/data": null
        });
    });

    it("takes the mount on top when a path is mounted twice", () => {
        const stacked = `${TABLE}\n50 40 8:1 /x /data/uploads rw - ext4 /dev/sda1 rw`;
        expect(mountTypes(stacked, ["/data/uploads"]).get("/data/uploads")).toBe("ext4");
    });
});

describe("boundToShare", () => {
    it("holds only when every path is on a network filesystem", () => {
        expect(boundToShare(TABLE, ["/data/uploads", "/srv"])).toBe(true);
        expect(boundToShare(TABLE, ["/data/uploads", "/cache"])).toBe(false);
        expect(boundToShare(TABLE, ["/nowhere"])).toBe(false);
    });
});

describe("nasBinding", () => {
    const ok = { code: 0, output: "" };

    it("is the share when the table says so and the files answer", async () => {
        await expect(
            nasBinding(ports({ cat: { code: 0, output: TABLE }, ls: ok }), "c", ["/data/uploads"])
        ).resolves.toBe("share");
    });

    it("is dead when the files answer like a mount that died", async () => {
        const dead = { code: 1, output: "ls: /data/uploads: Host is down" };
        await expect(
            nasBinding(ports({ cat: { code: 0, output: TABLE }, ls: dead }), "c", ["/data/uploads"])
        ).resolves.toBe("dead");
    });

    it("is local when the volume is not on a network filesystem", async () => {
        await expect(
            nasBinding(ports({ cat: { code: 0, output: TABLE }, ls: ok }), "c", ["/cache"])
        ).resolves.toBe("local");
    });

    it("is unknown when the image cannot be asked, and dead still shows through", async () => {
        await expect(nasBinding(ports({}), "c", ["/data/uploads"])).resolves.toBe("unknown");
        await expect(
            nasBinding(ports({ ls: { code: 1, output: "Stale file handle" } }), "c", ["/data"])
        ).resolves.toBe("dead");
    });
});
