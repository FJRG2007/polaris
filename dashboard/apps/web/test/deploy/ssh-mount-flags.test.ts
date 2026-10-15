/**
 * A share already mounted on a server reached over SSH, missing a flag Polaris now
 * asks for (`mfsymlinks`, without which the share refuses every link), is
 * remounted in place once instead of waiting for the machine to restart. The
 * script `ensureMount` sends runs under a real `sh` against a fixture mount
 * table, with `mount` and `umount` replaced by stubs that only record their call.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

vi.mock("@polaris/db", () => ({ prisma: {} }));

let root = "";
vi.mock("@polaris/ssh", async (load) => ({
    ...(await load<object>()),
    openSshClient: async () => ({ end: () => undefined }),
    execCommand: async (
        _client: unknown,
        command: string,
        options: { onStdout?: (chunk: Buffer) => void }
    ) => {
        const script = command
            .replaceAll("/proc/self/mountinfo", `${root}/mountinfo`)
            .replaceAll("/mnt/polaris", `${root}/mnt`);
        const result = spawnSync("sh", ["-c", script], {
            env: { ...process.env, PATH: `${root}/bin:${process.env.PATH ?? ""}` },
            encoding: "utf8"
        });
        options.onStdout?.(Buffer.from(result.stdout));
        return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
    }
}));

const { SshPorts } = await import("@/lib/deploy/ports-ssh");

const OPTIONS = "vers=3.0,uid=0,gid=0,file_mode=0666,dir_mode=0777,nobrl,mfsymlinks";

function ports() {
    return new SshPorts({
        address: "server.example.test",
        port: 22,
        username: "polaris",
        auth: { kind: "password", password: "fixture" } as never,
        hostKey: null as never,
        hostId: "host-1"
    });
}

function mountAt(options: string): void {
    const target = `${root}/mnt/share-1`;
    mkdirSync(target, { recursive: true });
    writeFileSync(
        `${root}/mountinfo`,
        `31 30 0:29 / ${target} rw,relatime - cifs //nas/share ${options}\n`
    );
}

function calls(): string[] {
    try {
        return readFileSync(`${root}/calls`, "utf8").trim().split("\n").filter(Boolean);
    } catch {
        return [];
    }
}

const spec = {
    id: "share-1",
    kind: "smb" as const,
    source: "//nas/share",
    options: OPTIONS,
    username: "fixture-user",
    password: "fixture-pass"
};

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "polaris-mount-")).replaceAll("\\", "/");
    mkdirSync(`${root}/bin`);
    for (const tool of ["mount", "umount"]) {
        writeFileSync(`${root}/bin/${tool}`, `#!/bin/sh\necho "${tool} $*" >> "${root}/calls"\n`, {
            mode: 0o755
        });
    }
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("SshPorts.ensureMount on a live share", () => {
    it("remounts in place, once, when a requested flag is missing", async () => {
        mountAt("rw,vers=3.0,uid=0,nobrl");
        expect(await ports().ensureMount(spec)).toBe(false);
        expect(calls()).toHaveLength(1);
        expect(calls()[0]).toMatch(/^mount -t cifs \/\/nas\/share \S+ -o remount,credentials=/);
        expect(calls()[0]).toContain(",mfsymlinks");
        // The kernel did not take it (the table is unchanged): no second try.
        expect(await ports().ensureMount(spec)).toBe(false);
        expect(calls()).toHaveLength(1);
    });

    it("leaves a share that already has every flag alone", async () => {
        mountAt("rw,vers=3.0,uid=0,nobrl,mfsymlinks");
        expect(await ports().ensureMount(spec)).toBe(false);
        expect(calls()).toEqual([]);
    });

    it("keeps the mount when the remount is refused", async () => {
        mountAt("rw,vers=3.0,nobrl");
        writeFileSync(`${root}/bin/mount`, "#!/bin/sh\nexit 32\n", { mode: 0o755 });
        expect(await ports().ensureMount(spec)).toBe(false);
    });

    it("mounts a share that is not mounted yet", async () => {
        writeFileSync(`${root}/mountinfo`, "");
        expect(await ports().ensureMount(spec)).toBe(true);
        expect(calls()).toHaveLength(1);
        expect(calls()[0]).not.toContain("remount");
    });
});
