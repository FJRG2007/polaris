import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as parse from "@polaris-app/security-scans/src/model/parse";
import * as specs from "@polaris-app/security-scans/src/model/specs";
import * as schemas from "@polaris-app/security-scans/src/model/schemas";
import * as updatesModel from "@polaris-app/security-scans/src/model/updates";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("malware log", () => {
    it("reads hits by volume and path, and the exit code", () => {
        const log = [
            "POLARIS_SIGNATURES_STALE",
            "/scan/0/uploads/eicar.com: Win.Test.EICAR_HDB-1 FOUND",
            "/scan/1/a dir/x: y.php: Php.Malware.Agent-1 FOUND\r",
            "/scan/0/locked: Access denied. ERROR",
            "POLARIS_EXIT code=1"
        ].join("\n");
        const report = parse.parseMalwareLog(log);
        expect(report.hits).toEqual([
            { volume: 0, path: "uploads/eicar.com", signature: "Win.Test.EICAR_HDB-1" },
            { volume: 1, path: "a dir/x: y.php", signature: "Php.Malware.Agent-1" }
        ]);
        expect(report.staleSignatures).toBe(true);
        expect(report.noSignatures).toBe(false);
        expect(report.exitCode).toBe(1);
    });

    it("says when there were no signatures to scan with", () => {
        const report = parse.parseMalwareLog("POLARIS_NO_SIGNATURES\n");
        expect(report.noSignatures).toBe(true);
        expect(report.exitCode).toBeNull();
    });
});

describe("file manifests", () => {
    it("parses hash lines, sorted, and skips noise", () => {
        const log = `POLARIS_FILES n=2\n${HASH_B}  ./z.txt\n${HASH_A}  ./dir/a b.txt\nnot a line\nPOLARIS_DONE\n`;
        const report = parse.parseFilesLog(log);
        expect([...report.manifest.keys()]).toEqual(["dir/a b.txt", "z.txt"]);
        expect(report.counted).toBe(2);
        expect(report.complete).toBe(true);
    });

    it("round-trips and diffs", () => {
        const before = new Map([
            ["a", HASH_A],
            ["b", HASH_A],
            ["c", HASH_A]
        ]);
        const after = new Map([
            ["a", HASH_A],
            ["b", HASH_B],
            ["d", HASH_A]
        ]);
        const decoded = parse.decodeManifest(parse.encodeManifest(before));
        expect([...decoded.entries()]).toEqual([...before.entries()]);
        const diff = parse.diffManifests(decoded, after);
        expect(diff.added).toEqual(["d"]);
        expect(diff.removed).toEqual(["c"]);
        expect(diff.changed).toEqual(["b"]);
        expect(diff.totals).toEqual({ added: 1, removed: 1, changed: 1 });
    });

    it("caps the lists but keeps the real totals", () => {
        const now = new Map(
            Array.from({ length: 300 }, (_, i) => [`f${i}`, HASH_A] as [string, string])
        );
        const diff = parse.diffManifests(new Map(), now, 10);
        expect(diff.added).toHaveLength(10);
        expect(diff.totals.added).toBe(300);
    });

    it("ignores a stored manifest that is not one", () => {
        expect(parse.decodeManifest('{"x":1}').size).toBe(0);
        expect(parse.decodeManifest('[["a", 1], ["b", "h"]]').size).toBe(1);
    });
});

describe("host audit report", () => {
    const report = [
        "Fetching...",
        "POLARIS_REPORT",
        "# Lynis Report",
        "hardening_index=67",
        "lynis_tests_done=241",
        "os_name=Ubuntu",
        "os_version=24.04",
        "warning[]=SSH-7408|Root can log in over SSH|-|-|",
        "suggestion[]=PKGS-7392|Install pending security updates|apt|-|",
        "suggestion[]=|no test|-|-|",
        "installed_packages_array[]=x"
    ].join("\n");

    it("reads the score, the system and every item", () => {
        const parsed = parse.parseAuditReport(report);
        expect(parsed.score).toBe(67);
        expect(parsed.testsRun).toBe(241);
        expect(parsed.os).toBe("Ubuntu 24.04");
        expect(parsed.items).toEqual([
            { kind: "warning", test: "SSH-7408", text: "Root can log in over SSH", detail: null },
            {
                kind: "suggestion",
                test: "PKGS-7392",
                text: "Install pending security updates",
                detail: "apt"
            }
        ]);
    });

    it("has no score when the report carries none", () => {
        expect(parse.parseAuditReport("POLARIS_REPORT\nos=Linux").score).toBeNull();
    });

    it("names an area for a check id", () => {
        expect(parse.auditArea("SSH-7408")).toBe("ssh");
        expect(parse.auditArea("ZZZZ-1")).toBe("other");
    });
});

describe("automatic updates output", () => {
    it("reads the state and the distribution", () => {
        expect(parse.parseUpdatesLog("POLARIS_DISTRO id=debian\nPOLARIS_UPDATES=on\n")).toEqual({
            state: "on",
            distro: "debian",
            pending: null,
            securityPending: null,
            // An older daemon's script says nothing about restarts: unknown, not "none".
            reboot: null,
            rebootAt: null,
            held: null
        });
        expect(
            parse.parseUpdatesLog("POLARIS_DISTRO id=\nPOLARIS_UPDATES=unsupported")
        ).toMatchObject({ state: "unsupported", distro: null });
        expect(parse.parseUpdatesLog("garbage").state).toBeNull();
    });

    it("reads what the server is waiting on and a restart it needs", () => {
        const waiting = parse.parseUpdatesLog(
            "POLARIS_DISTRO id=ubuntu\nPOLARIS_UPDATES=on\nPOLARIS_PENDING=130\nPOLARIS_SECURITY=4\nPOLARIS_REBOOT=required\n"
        );
        expect(waiting).toMatchObject({ pending: 130, securityPending: 4, reboot: "required" });
        const clean = parse.parseUpdatesLog("POLARIS_UPDATES=off\nPOLARIS_PENDING=0\nPOLARIS_SECURITY=0\n");
        expect(clean.reboot).toBe("none");
    });

    it("reads a scheduled restart from systemd's microseconds", () => {
        const at = parse.parseUpdatesLog(
            "POLARIS_UPDATES=on\nPOLARIS_PENDING=0\nPOLARIS_SECURITY=0\nPOLARIS_REBOOT=required\nPOLARIS_REBOOT_AT=1764214200000000\n"
        );
        expect(at.reboot).toBe("scheduled");
        expect(at.rebootAt?.getTime()).toBe(1764214200000);
        // A cancelled one is gone from systemd, so nothing is scheduled.
        expect(parse.parseUpdatesLog("POLARIS_REBOOT=cancelled").reboot).toBe("none");
    });

    it("restarts only when the host says one is pending, and sets the nightly window", () => {
        const schedule = specs.UPDATES_SCRIPTS["reboot-schedule"];
        expect(schedule).toContain("if [ -f /var/run/reboot-required ]");
        expect(schedule).toContain("shutdown -r 04:30 'Polaris:");
        expect(specs.hostArgv("reboot-cancel").at(-1)).toContain("shutdown -c");
        expect(specs.hostArgv("reboot-schedule")).toContain("--privileged");
        const on = specs.UPDATES_SCRIPTS["updates-on"];
        expect(on).toContain("apt-daily-upgrade.timer.d/polaris.conf");
        expect(on).toContain("dnf-automatic.timer.d/polaris.conf");
        // The scripts reach the daemon and SSH as one line.
        for (const script of Object.values(specs.UPDATES_SCRIPTS)) {
            expect(/[\u0000-\u001f\u007f]/.test(script)).toBe(false);
        }
    });
});

describe("held packages", () => {
    it("lists what a status read says is held, and nothing when it did not say", () => {
        const read = parse.parseUpdatesLog(
            "POLARIS_UPDATES=on\nPOLARIS_HOLDS\nPOLARIS_HELD=openssl\nPOLARIS_HELD=libc6\nPOLARIS_HELD=openssl\nPOLARIS_HELD=$(id)\n"
        );
        expect(read.held).toEqual(["openssl", "libc6"]);
        expect(parse.parseUpdatesLog("POLARIS_UPDATES=on\nPOLARIS_HOLDS\n").held).toEqual([]);
        expect(parse.parseUpdatesLog("POLARIS_UPDATES=on\n").held).toBeNull();
    });

    it("reads a package's versions, and a missing one", () => {
        expect(
            parse.parsePackageVersions(
                "POLARIS_DISTRO id=debian\nPOLARIS_INSTALLED=3.0.15-1~deb12u1\nPOLARIS_KEPT=yes\nPOLARIS_VERSION=3.0.15-1~deb12u1\nPOLARIS_VERSION=3.0.14-1~deb12u2\n"
            )
        ).toEqual({
            state: "ok",
            installed: "3.0.15-1~deb12u1",
            held: true,
            versions: ["3.0.15-1~deb12u1", "3.0.14-1~deb12u2"]
        });
        expect(parse.parsePackageVersions("POLARIS_PACKAGE=missing")?.state).toBe("missing");
        expect(parse.parsePackageVersions("garbage")).toBeNull();
        expect(parse.parseHoldLog("POLARIS_HOLD=held")).toBe("held");
        expect(parse.parseRollbackLog("POLARIS_ROLLBACK=unavailable")).toBe("unavailable");
        expect(parse.parseRollbackLog("")).toBeNull();
    });

    it("passes the package as the script's own words, never inside it", () => {
        const args = specs.hostArgv("package-rollback", ["libssl3", "1:3.0.15-1"]);
        expect(args.slice(-3)).toEqual(["polaris", "libssl3", "1:3.0.15-1"]);
        expect(args.at(-4)).toBe(specs.UPDATES_SCRIPTS["package-rollback"]);
        expect(specs.hostArgv("package-hold").at(-1)).toBe(specs.UPDATES_SCRIPTS["package-hold"]);
        // A rollback never removes another package to make room.
        expect(specs.UPDATES_SCRIPTS["package-rollback"]).toContain("--no-remove");
    });

    it("accepts the names the daemon accepts and nothing that reads as an option or code", () => {
        for (const ok of ["openssl", "libstdc++6", "python3.11", "NetworkManager", "perl_x"]) {
            expect(schemas.packageName.safeParse(ok).success).toBe(true);
        }
        for (const bad of ["", "-y", "a b", "a;reboot", "$(id)", "a\nb", "a".repeat(129)]) {
            expect(schemas.packageName.safeParse(bad).success).toBe(false);
        }
        expect(schemas.packageVersion.safeParse("1:3.0.15-1~deb12u1").success).toBe(true);
        expect(schemas.packageVersion.safeParse("-1").success).toBe(false);
        expect(
            schemas.rollbackInput.safeParse({
                targetId: "00000000-0000-4000-8000-000000000000",
                package: "openssl",
                version: "1.0",
                extra: 1
            }).success
        ).toBe(false);
    });
});

describe("updates on by default", () => {
    it("turns them on once, only for a server nobody chose for", () => {
        expect(updatesModel.armsUpdates(null)).toBe(true);
        expect(updatesModel.armsUpdates({ updatesChoice: null, updatesArmedAt: null })).toBe(true);
        // Already armed once: a later "off" by the host itself is not undone either.
        expect(
            updatesModel.armsUpdates({ updatesChoice: null, updatesArmedAt: new Date(0) })
        ).toBe(false);
    });

    it("keeps a person's off for good, before or after Polaris armed it", () => {
        expect(updatesModel.armsUpdates({ updatesChoice: "off", updatesArmedAt: null })).toBe(false);
        expect(
            updatesModel.armsUpdates({ updatesChoice: "off", updatesArmedAt: new Date(0) })
        ).toBe(false);
        expect(updatesModel.armsUpdates({ updatesChoice: "on", updatesArmedAt: null })).toBe(false);
    });
});

describe("image vulnerabilities", () => {
    const output = {
        matches: [
            {
                vulnerability: {
                    id: "CVE-2024-0001",
                    severity: "High",
                    fix: { versions: ["1.2.4"], state: "fixed" },
                    dataSource: "https://nvd.nist.gov/vuln/detail/CVE-2024-0001"
                },
                artifact: { name: "openssl", version: "1.2.3" }
            },
            {
                vulnerability: {
                    id: "CVE-2024-0002",
                    severity: "Critical",
                    fix: { versions: [] },
                    dataSource: "javascript:x"
                },
                artifact: { name: "zlib", version: "1.0" }
            },
            {
                vulnerability: { id: "CVE-2024-0002", severity: "Critical" },
                artifact: { name: "zlib", version: "1.0" }
            },
            {
                vulnerability: { id: "GHSA-x", severity: "weird" },
                artifact: { name: "left-pad", version: "1" }
            },
            { vulnerability: {}, artifact: {} }
        ]
    };

    it("counts by severity, worst first, without duplicates", () => {
        const text = `noise before\n${JSON.stringify(output)}\n`;
        const report = parse.parseVulnJson(parse.jsonOf(text))!;
        expect(report.total).toBe(3);
        expect(report.counts.critical).toBe(1);
        expect(report.counts.high).toBe(1);
        expect(report.counts.unknown).toBe(1);
        expect(report.items.map((item) => item.id)).toEqual([
            "CVE-2024-0002",
            "CVE-2024-0001",
            "GHSA-x"
        ]);
        expect(report.items[1]!.fixedIn).toBe("1.2.4");
        expect(report.items[0]!.fixedIn).toBeNull();
        // An unsafe link is dropped and the advisory page for the id stands in.
        expect(report.items[0]!.url).toBe("https://nvd.nist.gov/vuln/detail/CVE-2024-0002");
        expect(report.items[1]!.url).toMatch(/^https:/);
    });

    it("refuses what is not a match list", () => {
        expect(parse.parseVulnJson(parse.jsonOf("no json"))).toBeNull();
        expect(parse.parseVulnJson({ matches: "x" })).toBeNull();
    });

    it("summarizes a CycloneDX inventory", () => {
        expect(
            parse.summarizeSbom({
                bomFormat: "CycloneDX",
                specVersion: "1.6",
                components: [{}, {}]
            })
        ).toEqual({ format: "CycloneDX", specVersion: "1.6", components: 2 });
        expect(parse.summarizeSbom({ spdxVersion: "SPDX-2.3" })).toBeNull();
    });

    it("only exports a plain image reference, built here or pulled", () => {
        expect(parse.isImageRef("ghcr.io/acme/app:1.2")).toBe(true);
        expect(parse.isImageRef(`nginx@sha256:${HASH_A}`)).toBe(true);
        expect(parse.isImageRef("polaris-0123abcd:build-7")).toBe(true);
        expect(parse.isImageRef("x; rm -rf /")).toBe(false);
        expect(parse.isImageRef("-o=evil")).toBe(false);
        expect(parse.isImageRef("a b")).toBe(false);
    });
});

describe("one-off specs", () => {
    it("mounts each volume apart and passes paths as arguments", () => {
        const spec = specs.malwareSpec([
            { dockerName: "polaris-aaaa_data", subpath: "" },
            { dockerName: "polaris-bbbb_files", subpath: "up loads" }
        ]);
        const svc = spec.services[0]!;
        expect(svc.image).toBe(specs.MALWARE_IMAGE);
        expect(svc.pullPolicy).toBe("missing");
        expect(svc.restart).toBe("no");
        expect(svc.entrypoint).toEqual(["/bin/sh", "-c"]);
        expect(svc.command).toEqual([
            specs.MALWARE_SCRIPT,
            "polaris",
            "/scan/0",
            "/scan/1/up loads"
        ]);
        expect(spec.volumes).toEqual(["signatures"]);
        expect(spec.externalVolumes).toEqual(["polaris-aaaa_data", "polaris-bbbb_files"]);
        expect(svc.volumes.map((v) => v.target)).toEqual(["/var/lib/clamav", "/scan/0", "/scan/1"]);
        expect(() => specs.malwareSpec([])).toThrow();
    });

    it("never splices a person's value into a script", () => {
        const evil = 'a"; rm -rf / #';
        const hold = specs.quarantineSpec("hold", "polaris-aaaa_data", evil, "f-1");
        expect(hold.services[0]!.command).toEqual([
            specs.QUARANTINE_SCRIPTS.hold,
            "polaris",
            evil,
            "f-1"
        ]);
        for (const script of [
            specs.MALWARE_SCRIPT,
            specs.FILES_SCRIPT,
            ...Object.values(specs.QUARANTINE_SCRIPTS)
        ]) {
            expect(script).not.toMatch(/[\n\r]/);
            expect(script).not.toContain(evil);
        }
    });

    it("pins every image by digest", () => {
        for (const image of [
            specs.TOOLS_IMAGE,
            specs.MALWARE_IMAGE,
            specs.VULN_IMAGE,
            specs.SBOM_IMAGE
        ]) {
            expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
        }
    });

    const SCAN_ID = "0190a5f2-8c3e-7d4a-9b1c-2e3f4a5b6c7d";
    const VOLUME = specs.exportVolumeName(SCAN_ID);

    it("names one export volume per scan, in the shape the daemon accepts", () => {
        expect(VOLUME).toBe("polaris-secscan-image-9b1c2e3f4a5b6c7d");
        expect(specs.isExportVolume(VOLUME)).toBe(true);
        expect(specs.isExportVolume("polaris-abcd_data")).toBe(false);
        expect(() => specs.exportVolumeName("x")).toThrow();
    });

    it("reads the image from its exported archive, with the cache in one project volume", () => {
        const vuln = specs.vulnSpec(VOLUME);
        const sbom = specs.sbomSpec(VOLUME);
        expect(vuln.project).toBe(sbom.project);
        expect(vuln.volumes).toEqual(["cache"]);
        expect(vuln.externalVolumes).toEqual([VOLUME]);
        expect(vuln.services[0]!.volumes.map((v) => v.target)).toEqual(["/cache", "/in"]);
        expect(vuln.services[0]!.command).toEqual([
            "docker-archive:/in/image.tar",
            "-o",
            "json",
            "-q"
        ]);
        expect(sbom.services[0]!.command).toEqual([
            "docker-archive:/in/image.tar",
            "-o",
            "cyclonedx-json",
            "-q"
        ]);
        expect(() => specs.vulnSpec("polaris-abcd_data")).toThrow();
    });

    it("exports without the engine socket, and checks the room first", () => {
        const argv = specs.exportArgv("polaris-0123abcd:build-7", VOLUME);
        expect(argv.save).toEqual(["docker", "save", "polaris-0123abcd:build-7"]);
        expect(argv.write).toContain("-i");
        expect(argv.write).toContain(`${VOLUME}:/in`);
        for (const command of Object.values(argv)) {
            expect(command.join(" ")).not.toContain("docker.sock");
        }
        expect(argv.remove).toEqual(["docker", "volume", "rm", "-f", VOLUME]);
        const df =
            "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100 50 2097152 50% /in\n";
        expect(specs.parseDfFree(df)).toBe(2 * 1024 ** 3);
        expect(specs.parseDfFree("nonsense")).toBeNull();
        expect(specs.hasRoom(1024, 2 * 1024 ** 3)).toBe(true);
        expect(specs.hasRoom(1024 ** 3 + 1, 2 * 1024 ** 3)).toBe(false);
    });

    it("sweeps only exports no running scan owns", () => {
        const other = "0190a5f2-8c3e-7d4a-9b1c-aaaaaaaaaaaa";
        const leftover = specs.exportVolumeName(other);
        const listed = [
            VOLUME,
            leftover,
            ` ${leftover}`,
            "polaris-abcd_data",
            "x-polaris-secscan-image-0123abcd",
            ""
        ];
        expect(specs.staleExports(listed, [SCAN_ID])).toEqual([leftover]);
        expect(specs.staleExports(listed, [SCAN_ID, other])).toEqual([]);
        expect(specs.staleExports(listed, [])).toEqual([VOLUME, leftover]);
        expect(specs.staleExports([VOLUME], ["not-a-uuid"])).toEqual([VOLUME]);
        expect(specs.staleExports([], [SCAN_ID])).toEqual([]);
        expect(specs.LIST_EXPORTS_ARGV.at(-1)).toBe("name=polaris-secscan-image-");
    });

    it("exports with the same commands the daemon runs", () => {
        const rust = readFileSync(
            new URL("../../../../../../crates/polaris-hostd/src/host_security.rs", import.meta.url),
            "utf8"
        );
        expect(rust).toContain(`"${specs.EXPORT_VOLUME_PREFIX}"`);
        expect(rust).toContain('"cat > /in/image.tar"');
        expect(rust).toContain("1024 * 1024 * 1024");
        expect(specs.EXPORT_HEADROOM).toBe(1024 * 1024 * 1024);
    });

    it("audits the host read-only, and only the updates switch is privileged", () => {
        const audit = specs.hostArgv("audit");
        expect(audit).toContain("/:/host:ro");
        expect(audit).not.toContain("--privileged");
        const on = specs.hostArgv("updates-on");
        expect(on).toContain("--privileged");
        expect(on.at(-1)).toBe(specs.UPDATES_SCRIPTS["updates-on"]);
    });

    it("matches the host daemon's scripts word for word", () => {
        const rust = readFileSync(
            new URL("../../../../../../crates/polaris-hostd/src/host_security.rs", import.meta.url),
            "utf8"
        );
        for (const script of [
            specs.AUDIT_SCRIPT,
            specs.PACKAGES_SCRIPT,
            ...Object.values(specs.UPDATES_SCRIPTS)
        ]) {
            expect(rust).toContain(`r#"${script}"#`);
        }
        expect(rust).toContain(`"${specs.TOOLS_IMAGE}"`);
        expect(rust).toContain(`"${specs.HOST_CONTAINER}"`);
    });
});

describe("host packages", () => {
    const VOLUME = "polaris-secscan-image-0123abcd";

    it("copies the package database read-only, with no network, into the volume", () => {
        const argv = specs.packagesArgv(VOLUME);
        expect(argv.list).toContain("/:/host:ro");
        expect(argv.list).not.toContain("--privileged");
        const network = argv.list.indexOf("--network");
        expect(argv.list[network + 1]).toBe("none");
        expect(argv.list.at(-1)).toBe(specs.PACKAGES_SCRIPT);
        expect(argv.write).toContain(`${VOLUME}:/in`);
        expect(argv.write).not.toContain("/:/host:ro");
        expect(() => specs.packagesArgv("other")).toThrow();
    });

    it("reads the copied root as a directory with the image scanner", () => {
        const spec = specs.hostVulnSpec(VOLUME);
        const service = spec.services[0]!;
        expect(service.image).toBe(specs.VULN_IMAGE);
        expect(service.command?.[0]).toBe("dir:/in/root");
        expect(() => specs.hostVulnSpec("x")).toThrow();
    });

    it("applies security updates with the tool the automatic ones use", () => {
        const fix = specs.UPDATES_SCRIPTS["packages-fix"];
        expect(fix).toContain("unattended-upgrade");
        expect(fix).toContain("dnf upgrade --security -y");
        expect(specs.hostArgv("packages-fix")).toContain("--privileged");
        expect(parse.parseFixLog("POLARIS_DISTRO id=debian\nPOLARIS_FIX=done")).toBe("done");
        expect(parse.parseFixLog("POLARIS_FIX=unavailable")).toBe("unavailable");
        expect(parse.parseFixLog("nothing")).toBeNull();
    });
});

describe("inputs", () => {
    it("normalizes a folder inside a volume to one form", () => {
        expect(schemas.normalizeInnerPath("  ./a//b/ ")).toBe("a/b");
        expect(schemas.normalizeInnerPath("/x\\y")).toBe("x/y");
    });

    it("refuses a path that leaves the volume or reaches the quarantine", () => {
        const parsePath = (value: string) => schemas.innerPathSchema.safeParse(value).success;
        expect(parsePath("uploads/2024")).toBe(true);
        expect(parsePath("")).toBe(true);
        expect(parsePath("../etc")).toBe(false);
        expect(parsePath("a/../../b")).toBe(false);
        expect(parsePath("a\nb")).toBe(false);
        expect(parsePath(".polaris-quarantine/x")).toBe(false);
    });

    it("validates every action's input", () => {
        const id = "0190a5f2-8c3e-7d4a-9b1c-2e3f4a5b6c7d";
        expect(schemas.malwareInput.safeParse({ targetId: id, volumes: [] }).success).toBe(false);
        expect(
            schemas.malwareInput.safeParse({ targetId: id, volumes: [{ volumeId: id }] }).data
                ?.volumes[0]
        ).toEqual({ volumeId: id, subpath: "" });
        expect(schemas.scheduleInput.safeParse({ targetId: id, everyHours: 5 }).success).toBe(
            false
        );
        expect(schemas.scheduleInput.safeParse({ targetId: id, everyHours: 24 }).success).toBe(
            true
        );
        expect(schemas.updatesInput.safeParse({ targetId: "x", enabled: true }).success).toBe(
            false
        );
    });
});

describe("the restart security updates need", () => {
    const clear = { players: false, deploying: false };

    it("is scheduled by Polaris when nothing running there would be cut off", () => {
        expect(updatesModel.restartStep("required", null, clear)).toBe("schedule");
    });

    it("asks first when players or a deploy would be cut off", () => {
        expect(updatesModel.restartStep("required", null, { players: true, deploying: false })).toBe("ask");
        expect(updatesModel.restartStep("required", null, { players: false, deploying: true })).toBe("ask");
        expect(updatesModel.blockerReason({ players: true, deploying: true })).toBe("reasonBoth");
        expect(updatesModel.blockerReason({ players: false, deploying: true })).toBe("reasonDeploy");
    });

    it("tells once, and ends the alert when the server answers again without needing one", () => {
        const told = new Date();
        expect(updatesModel.restartStep("required", told, clear)).toBeNull();
        expect(updatesModel.restartStep("scheduled", told, clear)).toBeNull();
        expect(updatesModel.restartStep("none", told, clear)).toBe("back");
        expect(updatesModel.restartStep("none", null, clear)).toBeNull();
        // A read that could not say leaves everything as it was.
        expect(updatesModel.restartStep(null, told, clear)).toBeNull();
    });
});
