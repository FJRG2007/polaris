/**
 * SFTP accounts per service: what an account may be, and the server container
 * a set of them becomes - its mounts, its environment, its port.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/deployment-addresses", () => ({ reachableAddresses: async () => [] }));

import * as core from "@polaris/core";
import { fileAccessSpec } from "@/lib/deploy/file-access";

const service = {
    id: "0190f3a2-7c41-7000-8000-000000000001",
    slug: "web",
    projectSlug: "shop",
    volumes: [
        { name: "Uploads", kind: "volume", source: "uploads", connectionId: null },
        { name: "uploads", kind: "bind", source: "sites/shop", connectionId: null },
        { name: "media", kind: "nas", source: "media", connectionId: "c1" }
    ]
};

function decodeAccounts(value: string): string[][] {
    return Buffer.from(value, "base64")
        .toString("utf8")
        .split("\n")
        .map((line) => line.split("\t"));
}

describe("fileAccessAccountSchema", () => {
    it("normalizes the name and accepts a password", () => {
        const parsed = core.fileAccessAccountSchema.parse({ username: "  Deploy_1 ", password: "correct-horse-battery" });
        expect(parsed).toEqual({ username: "deploy_1", password: "correct-horse-battery", publicKey: undefined, readOnly: false });
    });

    it("asks for a password or a key", () => {
        expect(core.fileAccessAccountSchema.safeParse({ username: "deploy" }).success).toBe(false);
        expect(core.fileAccessAccountSchema.safeParse({ username: "deploy", password: "" }).success).toBe(false);
    });

    it("refuses reserved names, short passwords, and passwords holding the name", () => {
        expect(core.fileAccessAccountSchema.safeParse({ username: "root", password: "correct-horse-battery" }).success).toBe(false);
        expect(core.fileAccessAccountSchema.safeParse({ username: "deploy", password: "short" }).success).toBe(false);
        expect(core.fileAccessAccountSchema.safeParse({ username: "deploy", password: "my-deploy-password" }).success).toBe(false);
        expect(core.fileAccessAccountSchema.safeParse({ username: "deploy", password: "line\nbreak-password" }).success).toBe(false);
    });

    it("takes one OpenSSH key line, pasted over several lines or not", () => {
        const parsed = core.fileAccessAccountSchema.parse({
            username: "deploy",
            publicKey: "ssh-ed25519\nAAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyBody0000000000000000000000000000  me@laptop\n",
            readOnly: true
        });
        expect(parsed.publicKey).toBe("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyBody0000000000000000000000000000 me@laptop");
        expect(core.fileAccessAccountSchema.safeParse({ username: "deploy", publicKey: "not a key" }).success).toBe(false);
    });
});

describe("fileAccessSpec", () => {
    const spec = fileAccessSpec({
        service,
        port: 42222,
        logins: [
            { username: "deploy", password: "pa:ss\tword", readOnly: false },
            { username: "viewer", publicKey: "ssh-ed25519 AAAA me", readOnly: true }
        ]
    });
    const [server] = spec.services;

    it("mounts each volume under /srv by a unique folder, the named ones external", () => {
        expect(server.volumes).toEqual([
            { source: expect.stringMatching(/^polaris-[0-9a-f]{8}_uploads$/), target: "/srv/uploads", kind: "volume" },
            { source: "sites/shop", target: "/srv/uploads-2", kind: "bind" },
            { source: "c1/media", target: "/srv/media", kind: "nas" },
            { source: "keys", target: "/etc/ssh/polaris-keys", kind: "volume" }
        ]);
        expect(spec.externalVolumes).toEqual([server.volumes[0].source]);
        expect(spec.volumes).toEqual(["keys"]);
    });

    it("publishes only SSH, on the given port, and runs its own boot script", () => {
        expect(server.ports).toEqual([{ host: 42222, container: 22, protocol: "tcp" }]);
        expect(server.image).toBe(core.FILE_ACCESS_IMAGE);
        expect(server.entrypoint?.[2]).toContain("ChrootDirectory $ROOT");
        expect(server.entrypoint?.[2]).toContain("internal-sftp -R");
        expect(spec.project).toMatch(/^polaris-sftp-[0-9a-f]{8}$/);
    });

    it("carries the accounts with no control character in the environment", () => {
        for (const value of Object.values(server.env)) expect(value).not.toMatch(/[\x00-\x1f]/);
        const lines = decodeAccounts(server.env.POLARIS_SFTP_ACCOUNTS);
        expect(lines[0][0]).toBe("deploy");
        expect(lines[0][1]).toBe("rw");
        expect(Buffer.from(lines[0][2], "base64").toString("utf8")).toBe("pa:ss\tword");
        expect(lines[0][3]).toBe("-");
        expect(lines[1].slice(0, 3)).toEqual(["viewer", "ro", "-"]);
        expect(server.env.POLARIS_FIRST_FOLDER).toBe("uploads");
    });
});

describe("ports", () => {
    it("stays inside the range and wraps", () => {
        expect(core.fileAccessPortFor(123456)).toBeGreaterThanOrEqual(core.FILE_ACCESS_PORTS.from);
        expect(core.fileAccessPortFor(123456)).toBeLessThanOrEqual(core.FILE_ACCESS_PORTS.to);
        expect(core.nextFileAccessPort(core.FILE_ACCESS_PORTS.to)).toBe(core.FILE_ACCESS_PORTS.from);
    });
});
