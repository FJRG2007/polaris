/**
 * A backup that carries its home folder as `homedir.tar` comes out with the
 * folder unpacked in its place, and one whose home tar holds a path that leaves
 * it is refused. Runs the real `tar` on small archives built here, so it is
 * skipped on Windows, whose tars either read `C:` as a remote host (GNU) or list
 * in another column layout (bsdtar); the dashboard runs on Linux.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { BackupRefusal, inspectCpanelBackup } from "@/lib/deploy/panel-import/cpanel";

const scratch: string[] = [];

afterEach(async () => {
    for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A backup folder with `homedir.tar` built from `home`, packed as a .tar.gz. */
async function backupWithHomeTar(homeEntry: string): Promise<string> {
    const work = await mkdtemp(join(tmpdir(), "polaris-test-backup-"));
    scratch.push(work);
    const root = join(work, "backup-1.1.2026_example");
    const home = join(work, "home");
    await mkdir(join(root, "userdata"), { recursive: true });
    await mkdir(join(root, "mysql"), { recursive: true });
    await writeFile(join(root, "userdata", "main"), "main_domain: example.test\n");
    await writeFile(join(root, "userdata", "example.test"), "documentroot: /home/example/public_html\n");
    await mkdir(join(home, "public_html"), { recursive: true });
    await writeFile(join(home, "public_html", "index.html"), "hello");
    execFileSync("tar", ["-cf", join(root, "homedir.tar"), "-C", home, homeEntry]);
    const archive = join(work, "backup.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", work, "backup-1.1.2026_example"]);
    return archive;
}

describe.skipIf(process.platform === "win32")("homedir.tar", () => {
    it("is unpacked into homedir after the plan is read", async () => {
        const result = await inspectCpanelBackup(await backupWithHomeTar("public_html"));
        scratch.push(result.dir);
        expect(result.plan.hasHome).toBe(true);
        expect(result.plan.domains.map((domain) => domain.name)).toEqual(["example.test"]);
        expect(await readFile(join(result.root, "homedir", "public_html", "index.html"), "utf8")).toBe("hello");
        await expect(stat(join(result.root, "homedir.tar"))).rejects.toThrow();
    });

    it("is refused when it holds a path that leaves the folder", async () => {
        const archive = await backupWithHomeTar("../home/public_html");
        await expect(inspectCpanelBackup(archive)).rejects.toBeInstanceOf(BackupRefusal);
    });
});
