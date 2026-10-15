/**
 * Server templates without a server: the items a template becomes, what each
 * report line from the check script means as drift, and the command a fix
 * sends - which carries every value as a quoted argument after a fixed script,
 * never inside it.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { templateSpecSchema, type DriftItem, type TemplateSpecInput } from "@polaris/core";
import {
    CHECK_SCRIPT,
    FIX_SCRIPT,
    computeDrift,
    fixWords,
    parseReport,
    planItems,
    scriptCommand,
    sha256
} from "@/lib/server-templates/model";

const spec = (input: TemplateSpecInput) => templateSpecSchema.parse(input);

/** Report lines for items 1..n. */
const report = (...values: string[]) =>
    parseReport(values.map((value, index) => `@${index + 1} ${value}`).join("\n"));

/** Split a POSIX command line built from bare and single-quoted words back into
 *  its words, failing on anything a shell would expand. */
function words(line: string): string[] {
    const out: string[] = [];
    let i = 0;
    while (i < line.length) {
        if (line[i] === " ") {
            i++;
            continue;
        }
        let word = "";
        while (i < line.length && line[i] !== " ") {
            if (line[i] === "'") {
                const end = line.indexOf("'", i + 1);
                if (end < 0) throw new Error("unterminated quote");
                word += line.slice(i + 1, end);
                i = end + 1;
            } else if (line.startsWith("\\'", i)) {
                word += "'";
                i += 2;
            } else {
                if (!/[a-zA-Z0-9_./:=-]/.test(line[i]!))
                    throw new Error(`bare ${JSON.stringify(line[i])} would be read by the shell`);
                word += line[i];
                i++;
            }
        }
        out.push(word);
    }
    return out;
}

describe("the items a template becomes", () => {
    it("keeps a fixed order and a stable key per item", () => {
        const items = planItems(
            spec({
                firewall: [{ port: 443 }],
                users: [{ name: "deploy", groups: ["sudo", "docker"] }],
                sysctl: [{ key: "vm.swappiness", value: "10" }],
                files: [{ path: "/etc/motd", content: "hi", mode: "600" }],
                services: [{ name: "nginx", running: true, enabled: false }],
                packages: ["nginx"]
            })
        );
        expect(items.map((item) => item.key)).toEqual([
            "pkg:nginx",
            "svc:nginx",
            "file:/etc/motd",
            "sysctl:vm.swappiness",
            "user:deploy",
            "fw:443/tcp"
        ]);
        expect(items.map((item) => item.fix)).toEqual([
            ["pkg", "nginx", "-"],
            ["svc", "nginx", "10"],
            ["file", "/etc/motd", "600"],
            ["sysctl", "vm.swappiness", "10"],
            ["user", "deploy", "sudo,docker"],
            ["fw", "443", "tcp"]
        ]);
        expect(items[2]!.payload).toBe(Buffer.from("hi").toString("base64"));
    });
});

describe("what a report line means", () => {
    it("reads lines by number and ignores anything else the login prints", () => {
        expect([...parseReport("Welcome!\n@2 absent\r\n@1 installed\nnoise @3 x\n")]).toEqual([
            [2, "absent"],
            [1, "installed"]
        ]);
    });

    it("finds nothing wrong when every item matches", () => {
        const s = spec({
            packages: ["nginx"],
            services: [{ name: "nginx" }],
            files: [{ path: "/etc/motd", content: "hi", mode: "644" }],
            sysctl: [{ key: "net.ipv4.ip_forward", value: "1" }],
            users: [{ name: "deploy", groups: ["sudo"] }],
            firewall: [{ port: 22 }]
        });
        const drift = computeDrift(
            s,
            report(
                "installed",
                "active enabled",
                `644 ${sha256("hi")}`,
                "=1 ",
                "=deploy sudo",
                "allow"
            )
        );
        expect(drift).toEqual([]);
    });

    it("packages: missing is fixable, an unknown answer is not drift but unreadable", () => {
        const s = spec({ packages: ["a", "b", "c"] });
        expect(computeDrift(s, report("absent", "unknown"))).toEqual([
            { key: "pkg:a", code: "packageMissing", name: "a", fixable: true },
            { key: "pkg:b", code: "unreadable", name: "b", fixable: false },
            { key: "pkg:c", code: "unreadable", name: "c", fixable: false }
        ]);
    });

    it("services: each of running and boot is compared on its own", () => {
        const s = spec({
            services: [
                { name: "up", running: true, enabled: true },
                { name: "down", running: false, enabled: false },
                { name: "static", running: true, enabled: true },
                { name: "gone", running: true, enabled: true }
            ]
        });
        const drift = computeDrift(
            s,
            report("inactive disabled", "active enabled", "active static", "unknown")
        );
        expect(drift.map((item) => [item.key, item.code, item.actual])).toEqual([
            ["svc:up", "serviceStopped", "inactive"],
            ["svc:up", "serviceNotEnabled", "disabled"],
            ["svc:down", "serviceRunning", undefined],
            ["svc:down", "serviceEnabled", undefined],
            ["svc:gone", "unreadable", undefined]
        ]);
    });

    it("files: missing, other content and other mode are each named", () => {
        const s = spec({
            files: [
                { path: "/a", content: "x" },
                { path: "/b", content: "x", mode: "600" },
                { path: "/c", content: "x" }
            ]
        });
        const drift = computeDrift(s, report("absent", `644 ${sha256("y")}`, "garbage"));
        expect(drift).toEqual([
            { key: "file:/a", code: "fileMissing", name: "/a", fixable: true },
            { key: "file:/b", code: "fileContent", name: "/b", fixable: true },
            {
                key: "file:/b",
                code: "fileMode",
                name: "/b",
                expected: "600",
                actual: "644",
                fixable: true
            },
            { key: "file:/c", code: "unreadable", name: "/c", fixable: false }
        ]);
    });

    it("sysctl: compares values with their whitespace squashed", () => {
        const s = spec({
            sysctl: [
                { key: "net.ipv4.ip_local_port_range", value: "1024 65000" },
                { key: "vm.swappiness", value: "10" }
            ]
        });
        const drift = computeDrift(s, report("=1024\t 65000 ", "=60"));
        expect(drift).toEqual([
            {
                key: "sysctl:vm.swappiness",
                code: "sysctlValue",
                name: "vm.swappiness",
                expected: "10",
                actual: "60",
                fixable: true
            }
        ]);
    });

    it("users: missing, and the groups still to join", () => {
        const s = spec({
            users: [{ name: "a" }, { name: "b", groups: ["sudo", "docker", "adm"] }]
        });
        const drift = computeDrift(s, report("absent", "=b adm"));
        expect(drift).toEqual([
            { key: "user:a", code: "userMissing", name: "a", fixable: true },
            {
                key: "user:b",
                code: "userGroups",
                name: "b",
                expected: "sudo, docker",
                fixable: true
            }
        ]);
    });

    it("firewall: a missing rule is fixable, a firewall that is off or absent is not", () => {
        const s = spec({
            firewall: [
                { port: 22 },
                { port: 80 },
                { port: 443 },
                { port: 53, protocol: "udp" },
                { port: 8080 }
            ]
        });
        const drift = computeDrift(s, report("allow", "missing", "inactive", "noufw", "unknown"));
        expect(drift.map((item) => [item.key, item.code, item.fixable])).toEqual([
            ["fw:80/tcp", "firewallMissing", true],
            ["fw:443/tcp", "firewallOff", false],
            ["fw:53/udp", "firewallAbsent", false],
            ["fw:8080/tcp", "unreadable", false]
        ]);
    });
});

describe("the command a fix sends", () => {
    const hostile = spec({
        packages: ["nginx"],
        files: [{ path: "/tmp/$(reboot);`id` 'x' \"y\"", content: "line one\n$(whoami)\n" }],
        sysctl: [{ key: "vm.swappiness", value: "1; rm -rf / #" }],
        users: [{ name: "deploy", groups: ["sudo"] }]
    });
    const drift: DriftItem[] = computeDrift(hostile, report("absent", "absent", "=60", "absent"));

    it("runs a fixed script and passes every value as its own word", () => {
        const plan = fixWords(hostile, drift);
        const command = scriptCommand(FIX_SCRIPT, plan.words, false);
        const argv = words(command);
        expect(argv.slice(0, 4)).toEqual(["sh", "-c", FIX_SCRIPT, "polaris-template"]);
        expect(argv.slice(4)).toEqual(plan.words);
        expect(plan.words).toContain("/tmp/$(reboot);`id` 'x' \"y\"");
        expect(plan.words).toContain("1; rm -rf / #");
        expect(FIX_SCRIPT).not.toContain("reboot");
    });

    it("goes through password-less sudo only when asked", () => {
        expect(words(scriptCommand(CHECK_SCRIPT, ["pkg", "a", "-"], true)).slice(0, 4)).toEqual([
            "sudo",
            "-n",
            "sh",
            "-c"
        ]);
        expect(words(scriptCommand(CHECK_SCRIPT, ["pkg", "a", "-"], false))[0]).toBe("sh");
    });

    it("sends a file's content on stdin, never on the command line", () => {
        const plan = fixWords(hostile, drift);
        const command = scriptCommand(FIX_SCRIPT, plan.words, true);
        expect(command).not.toContain("whoami");
        expect(plan.input).toBe(`${Buffer.from("line one\n$(whoami)\n").toString("base64")}\n`);
    });

    it("puts back only the drift asked for, in template order, and never what it cannot fix", () => {
        const withUnreadable: DriftItem[] = [
            ...drift,
            { key: "pkg:other", code: "unreadable", name: "other", fixable: false }
        ];
        expect(fixWords(hostile, withUnreadable).keys).toEqual([
            "pkg:nginx",
            "file:/tmp/$(reboot);`id` 'x' \"y\"",
            "sysctl:vm.swappiness",
            "user:deploy"
        ]);
        const some = fixWords(hostile, withUnreadable, [
            "user:deploy",
            "pkg:other",
            "pkg:not-drift"
        ]);
        expect(some).toEqual({
            keys: ["user:deploy"],
            words: ["user", "deploy", "sudo"],
            input: ""
        });
        expect(fixWords(hostile, []).keys).toEqual([]);
    });

    // The scripts themselves, run by a real shell against a scratch directory:
    // a value built to run a command when expanded must arrive as plain text.
    const shell = spawnSync("sh", ["-c", "exit 0"]).status === 0;
    it.skipIf(!shell)("lets a shell read a hostile path only as a path", () => {
        const dir = mkdtempSync(join(tmpdir(), "polaris-template-"));
        try {
            // Run from the scratch directory, so a command that did run would
            // leave its mark there.
            const path = `${dir.replace(/\\/g, "/")}/a$(touch ran)\`touch ran\`;id`;
            const check = spawnSync(
                "sh",
                ["-c", CHECK_SCRIPT, "polaris-template", "file", path, "-"],
                { cwd: dir, encoding: "utf8" }
            );
            expect(check.stdout.trim()).toBe("@1 absent");

            const content = "one\n$(touch ran)\n";
            const fix = spawnSync(
                "sh",
                ["-c", FIX_SCRIPT, "polaris-template", "file", path, "600"],
                {
                    cwd: dir,
                    encoding: "utf8",
                    input: `${Buffer.from(content).toString("base64")}\n`
                }
            );
            expect(fix.stdout.trim()).toBe("@1 ok");
            expect(readFileSync(path, "utf8")).toBe(content);
            expect(existsSync(join(dir, "ran"))).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
