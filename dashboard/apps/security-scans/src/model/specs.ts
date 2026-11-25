/**
 * The one-off containers every scan runs in, as pure builders.
 *
 * Nothing here stays running: each spec is brought up, read through its logs
 * once it exits, and brought down. Every image is pinned by digest and pulled
 * only the first time a scan needs it ("missing"). Whatever a person chose (a
 * folder inside a volume, a quarantined file's path) reaches the script as a
 * positional argument (`"$1"`), never spliced into the script's text.
 *
 * The host-level work (the hardening audit and the automatic updates switch)
 * cannot be a compose spec: it needs the host's root mounted, which the deploy
 * daemon never allows. Those scripts live here for the SSH path and, word for
 * word, in the host daemon (`crates/polaris-hostd/src/host_security.rs`) for
 * the local one; a test holds the two to each other.
 */

import type { ComposeSpec, ComposeSpecService, ComposeSpecVolume } from "@polaris/deploy";

/** busybox's sh, find, sha256sum and mv. The multi-arch index of alpine 3.22. */
export const TOOLS_IMAGE =
    "alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8";

/** The malware scanner without bundled signatures: they are fetched into a
 *  small volume by the scan itself and refreshed on every run. */
export const MALWARE_IMAGE =
    "clamav/clamav:1.4.6_base@sha256:1b483c3988220dae0e107911e2788c2a671ccd4ec01901777f8ac02e518d3af2";

/** The image vulnerability matcher. */
export const VULN_IMAGE =
    "anchore/grype:v0.120.1@sha256:e4a44ef45d285b829ce6efe2642980329661bd2d18eab5fc539138d4adaebbbe";

/** The software bill of materials generator. */
export const SBOM_IMAGE =
    "anchore/syft:v1.54.1@sha256:3eb5379ba7b409c3f4069b686110527af0c47df993fa5c10d13e7cf34f49b1aa";

/** Where a volume keeps what was taken out of reach. Skipped by every scan. */
export const QUARANTINE_DIR = ".polaris-quarantine";

/** More files than this in one baseline is refused rather than half-recorded. */
export const MAX_BASELINE_FILES = 50_000;

/** Compose projects: fixed per tool, so the cache volume each owns outlives
 *  the run (compose `down` keeps a project's volumes). */
export const PROJECTS = {
    malware: "polaris-secscan-malware",
    files: "polaris-secscan-files",
    images: "polaris-secscan-images"
} as const;

/** The throwaway image a dependency scan builds on a server: the scanner with
 *  the deployed commit's lockfiles in `/src`. One name per server, replaced by
 *  the next scan there (scans on one server run one at a time). */
export const DEPS_IMAGE = "polaris-secscan/deps:scan";

const LABELS = { "polaris.security-scan": "true" };

/** A volume as a scan mounts it. */
export interface ScanVolume {
    /** The Docker volume's own name (`polaris-<hash>_<source>`). */
    readonly dockerName: string;
    /** A folder inside it, relative, already normalized; empty for all of it. */
    readonly subpath: string;
}

function service(
    name: string,
    image: string,
    rest: Partial<ComposeSpecService> & { volumes: ComposeSpecVolume[] }
): ComposeSpecService {
    return {
        name,
        image,
        pullPolicy: "missing",
        env: {},
        ports: [],
        labels: LABELS,
        networks: [],
        restart: "no",
        // One core at most: a scan is background work beside the apps it checks.
        cpus: 1,
        ...rest
    };
}

function spec(
    project: string,
    svc: ComposeSpecService,
    owned: readonly string[],
    external: readonly string[]
): ComposeSpec {
    return {
        project,
        services: [svc],
        volumes: [...owned],
        networks: [],
        ...(external.length > 0 ? { externalVolumes: [...new Set(external)] } : {})
    };
}

function shellOf(
    script: string,
    args: readonly string[]
): Pick<ComposeSpecService, "entrypoint" | "command"> {
    // `$0` is a fixed word; the person's values start at `$1`.
    return { entrypoint: ["/bin/sh", "-c"], command: [script, "polaris", ...args] };
}

/**
 * Refresh the signatures, then scan. Prints `POLARIS_SIGNATURES_STALE` when the
 * refresh failed but older signatures are there to scan with, and exits 20 when
 * there are none at all. The scanner's own exit code is kept: 0 clean, 1 found.
 */
export const MALWARE_SCRIPT = [
    "freshclam --datadir=/var/lib/clamav --stdout --quiet >/tmp/refresh.log 2>&1 || echo POLARIS_SIGNATURES_STALE",
    "ls /var/lib/clamav/*.cvd /var/lib/clamav/*.cld >/dev/null 2>&1 || { echo POLARIS_NO_SIGNATURES; exit 20; }",
    `nice -n 19 clamscan --database=/var/lib/clamav --recursive --infected --no-summary --stdout --exclude-dir='/\\${QUARANTINE_DIR}$' --max-filesize=200M --max-scansize=400M "$@"`,
    "code=$?",
    'echo "POLARIS_EXIT code=$code"',
    "exit $code"
].join("; ");

/** Mount point of the n-th volume in a malware scan. */
export function scanMount(index: number): string {
    return `/scan/${index}`;
}

export function malwareSpec(volumes: readonly ScanVolume[]): ComposeSpec {
    if (volumes.length === 0) throw new Error("Nothing to scan");
    const mounts = volumes.map((volume, index) => ({
        source: volume.dockerName,
        target: scanMount(index),
        kind: "volume" as const
    }));
    const paths = volumes.map((volume, index) =>
        volume.subpath ? `${scanMount(index)}/${volume.subpath}` : scanMount(index)
    );
    return spec(
        PROJECTS.malware,
        service("polaris-secscan-malware", MALWARE_IMAGE, {
            ...shellOf(MALWARE_SCRIPT, paths),
            volumes: [
                { source: "signatures", target: "/var/lib/clamav", kind: "volume" },
                ...mounts
            ],
            memoryMb: 3072
        }),
        ["signatures"],
        volumes.map((volume) => volume.dockerName)
    );
}

/**
 * Hash every file under the chosen folder. Prints the count first and refuses
 * (exit 21) past `MAX_BASELINE_FILES`, so a cache folder with a million entries
 * is named rather than half-recorded.
 */
export const FILES_SCRIPT = [
    'cd "/v/$1" || exit 10',
    `n=$(find . -path ./${QUARANTINE_DIR} -prune -o -type f -print | wc -l)`,
    'echo "POLARIS_FILES n=$n"',
    `[ "$n" -le ${MAX_BASELINE_FILES} ] || exit 21`,
    `find . -path ./${QUARANTINE_DIR} -prune -o -type f -exec nice -n 19 sha256sum {} +`,
    "echo POLARIS_DONE"
].join("; ");

export function filesSpec(volume: ScanVolume): ComposeSpec {
    return spec(
        PROJECTS.files,
        service("polaris-secscan-files", TOOLS_IMAGE, {
            ...shellOf(FILES_SCRIPT, [volume.subpath]),
            volumes: [{ source: volume.dockerName, target: "/v", kind: "volume" }]
        }),
        [],
        [volume.dockerName]
    );
}

/** What can be done with one file found by a scan. */
export type QuarantineOp = "hold" | "restore" | "delete";

/** `$1` is the file's path in the volume, `$2` the name it is kept under. */
export const QUARANTINE_SCRIPTS: Readonly<Record<QuarantineOp, string>> = {
    hold: [
        "cd /v || exit 10",
        '[ -f "./$1" ] || exit 2',
        `mkdir -p ${QUARANTINE_DIR} && chmod 700 ${QUARANTINE_DIR}`,
        `mv -f -- "./$1" "${QUARANTINE_DIR}/$2" && chmod 000 "${QUARANTINE_DIR}/$2" && echo POLARIS_OK`
    ].join("; "),
    restore: [
        "cd /v || exit 10",
        '[ -e "./$1" ] && exit 3',
        `[ -f "${QUARANTINE_DIR}/$2" ] || exit 2`,
        'mkdir -p -- "$(dirname -- "./$1")"',
        `mv -- "${QUARANTINE_DIR}/$2" "./$1" && chmod 600 "./$1" && echo POLARIS_OK`
    ].join("; "),
    delete: ["cd /v || exit 10", `rm -f -- "${QUARANTINE_DIR}/$2"`, "echo POLARIS_OK"].join("; ")
};

export function quarantineSpec(
    op: QuarantineOp,
    dockerName: string,
    path: string,
    keptAs: string
): ComposeSpec {
    return spec(
        PROJECTS.files,
        service("polaris-secscan-hold", TOOLS_IMAGE, {
            ...shellOf(QUARANTINE_SCRIPTS[op], [path, keptAs]),
            volumes: [{ source: dockerName, target: "/v", kind: "volume" }]
        }),
        [],
        [dockerName]
    );
}

/* -------------------------------------------------------------------------- */
/* Images                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * An image is scanned from an archive of it, never through the engine's
 * socket: the host saves the image the app runs into a short-lived volume of
 * this name, the tools read `/in/image.tar`, and the volume is removed after.
 * That covers images built on the server, which no registry has.
 */
export const EXPORT_VOLUME_PREFIX = "polaris-secscan-image-";
export const ARCHIVE_SOURCE = "docker-archive:/in/image.tar";
/** Room kept free beyond the archive itself. */
export const EXPORT_HEADROOM = 1024 * 1024 * 1024;

/** The export volume of one scan: the prefix and 16 hex of its id. */
export function exportVolumeName(scanId: string): string {
    const hex = scanId.toLowerCase().replace(/[^0-9a-f]/g, "");
    if (hex.length < 16) throw new Error("A scan id is needed to name its export");
    return `${EXPORT_VOLUME_PREFIX}${hex.slice(-16)}`;
}

export function isExportVolume(name: string): boolean {
    return /^polaris-secscan-image-[0-9a-f]{8,32}$/.test(name);
}

/** Lists the export volumes on a server (a substring filter; see below). */
export const LIST_EXPORTS_ARGV = [
    "docker",
    "volume",
    "ls",
    "-q",
    "--filter",
    `name=${EXPORT_VOLUME_PREFIX}`
];

/**
 * The export volumes a sweep may remove: every one on the server that is an
 * export by its exact shape and does not belong to a scan still running. The
 * running scans must be read after the volumes were listed, so a scan claimed
 * in between (whose volume the list cannot hold yet) is never swept.
 */
export function staleExports(
    listed: readonly string[],
    runningScanIds: readonly string[]
): string[] {
    const live = new Set(
        runningScanIds.flatMap((id) => {
            try {
                return [exportVolumeName(id)];
            } catch {
                return [];
            }
        })
    );
    return [...new Set(listed.map((name) => name.trim()))].filter(
        (name) => isExportVolume(name) && !live.has(name)
    );
}

/** The free bytes `df -Pk` reports on its one filesystem line. */
export function parseDfFree(output: string): number | null {
    const kib = Number(output.split("\n")[1]?.trim().split(/\s+/)[3]);
    return Number.isSafeInteger(kib) && kib >= 0 ? kib * 1024 : null;
}

export function hasRoom(size: number, free: number): boolean {
    return size + EXPORT_HEADROOM <= free;
}

/** The commands an export is made of, the same ones the host daemon runs
 *  locally, for the SSH path. Each is an argument list. */
export function exportArgv(image: string, volume: string) {
    const run = (interactive: boolean, tail: readonly string[]) => [
        "docker",
        "run",
        "--rm",
        ...(interactive ? ["-i"] : []),
        "--network",
        "none",
        "-v",
        `${volume}:/in`,
        TOOLS_IMAGE,
        ...tail
    ];
    return {
        size: ["docker", "image", "inspect", "--format", "{{.Size}}", image],
        free: run(false, ["df", "-Pk", "/in"]),
        save: ["docker", "save", image],
        write: run(true, ["/bin/sh", "-c", "cat > /in/image.tar"]),
        check: run(false, ["/bin/sh", "-c", "tar -tf /in/image.tar >/dev/null"]),
        remove: ["docker", "volume", "rm", "-f", volume]
    };
}

function imageToolSpec(
    name: string,
    image: string,
    volume: string,
    output: string,
    env: Record<string, string>
): ComposeSpec {
    if (!isExportVolume(volume)) throw new Error("Not an export volume");
    return spec(
        PROJECTS.images,
        service(name, image, {
            command: [ARCHIVE_SOURCE, "-o", output, "-q"],
            env,
            volumes: [
                { source: "cache", target: "/cache", kind: "volume" },
                { source: volume, target: "/in", kind: "volume" }
            ],
            memoryMb: 2048
        }),
        ["cache"],
        [volume]
    );
}

/** Vulnerabilities of an exported image, as JSON. */
export function vulnSpec(volume: string): ComposeSpec {
    return imageToolSpec("polaris-secscan-match", VULN_IMAGE, volume, "json", {
        GRYPE_DB_CACHE_DIR: "/cache/vulnerabilities",
        GRYPE_CHECK_FOR_APP_UPDATE: "false"
    });
}

/** Vulnerabilities of the lockfiles in the deps image, as JSON: Grype's own
 *  directory catalogers read them (`dir:` source), offline once its database
 *  is in the shared cache. */
export function depsSpec(): ComposeSpec {
    // The image scans' project, so the vulnerability database in its cache is
    // the one already downloaded there.
    return spec(
        PROJECTS.images,
        service("polaris-secscan-deps", DEPS_IMAGE, {
            pullPolicy: "never",
            command: ["dir:/src", "-o", "json", "-q"],
            env: {
                GRYPE_DB_CACHE_DIR: "/cache/vulnerabilities",
                GRYPE_CHECK_FOR_APP_UPDATE: "false"
            },
            volumes: [{ source: "cache", target: "/cache", kind: "volume" }],
            memoryMb: 1024
        }),
        ["cache"],
        []
    );
}

/** An exported image's bill of materials, as CycloneDX JSON. */
export function sbomSpec(volume: string): ComposeSpec {
    return imageToolSpec("polaris-secscan-inventory", SBOM_IMAGE, volume, "cyclonedx-json", {
        SYFT_CHECK_FOR_APP_UPDATE: "false",
        SYFT_CACHE_DIR: "/cache/inventory"
    });
}

/* -------------------------------------------------------------------------- */
/* Host-level work                                                             */
/* -------------------------------------------------------------------------- */

export type HostAction =
    | "audit"
    | "updates-status"
    | "updates-on"
    | "updates-off"
    | "reboot-schedule"
    | "reboot-cancel"
    | "packages-fix"
    | "package-versions"
    | "package-hold"
    | "package-unhold"
    | "package-rollback";

/** The actions that are about one package, and the rollback's version. */
export type PackageAction = "package-versions" | "package-hold" | "package-unhold" | "package-rollback";

/** The hardening audit, run against the host's root mounted read-only. */
export const AUDIT_SCRIPT =
    "apk add --no-cache --quiet lynis >/dev/null 2>&1 || { echo POLARIS_NO_TOOL; exit 20; }; nice -n 19 lynis audit system --rootdir /host --quick --no-colors --no-log --report-file /tmp/report.dat >/dev/null 2>&1; [ -s /tmp/report.dat ] || exit 21; echo POLARIS_REPORT; cat /tmp/report.dat";

const DISTRO = '. /etc/os-release 2>/dev/null; echo "POLARIS_DISTRO id=$ID"';

/** The automatic security updates switch, run inside the host's root. */
export const UPDATES_SCRIPTS: Readonly<Record<Exclude<HostAction, "audit">, string>> = {
    "updates-status": `${DISTRO}; if command -v apt-get >/dev/null 2>&1; then if grep -qs 'Unattended-Upgrade "1"' /etc/apt/apt.conf.d/20auto-upgrades && dpkg -s unattended-upgrades >/dev/null 2>&1; then echo POLARIS_UPDATES=on; else echo POLARIS_UPDATES=off; fi; echo "POLARIS_PENDING=$(apt-get -s -o Debug::NoLocking=1 upgrade 2>/dev/null | grep -c '^Inst ')"; echo "POLARIS_SECURITY=$(apt-get -s -o Debug::NoLocking=1 upgrade 2>/dev/null | grep '^Inst ' | grep -ci security)"; [ -f /var/run/reboot-required ] && echo POLARIS_REBOOT=required; echo POLARIS_HOLDS; apt-mark showhold 2>/dev/null | sed 's/^/POLARIS_HELD=/'; elif command -v dnf >/dev/null 2>&1; then if systemctl is-enabled dnf-automatic.timer >/dev/null 2>&1; then echo POLARIS_UPDATES=on; else echo POLARIS_UPDATES=off; fi; echo "POLARIS_PENDING=$(dnf -q -C check-update 2>/dev/null | grep -c '^[[:alnum:]]')"; echo "POLARIS_SECURITY=$(dnf -q -C check-update --security 2>/dev/null | grep -c '^[[:alnum:]]')"; command -v needs-restarting >/dev/null 2>&1 && { needs-restarting -r >/dev/null 2>&1 || echo POLARIS_REBOOT=required; }; echo POLARIS_HOLDS; dnf -q -C versionlock list 2>/dev/null | awk '/^Package name: / {print "POLARIS_HELD=" $3; next} /^#/ || / / || NF == 0 {next} {n = split($0, a, "-"); if (n > 2) {s = a[1]; for (i = 2; i <= n - 2; i++) s = s "-" a[i]; print "POLARIS_HELD=" s}}'; else echo POLARIS_UPDATES=unsupported; fi; [ -f /run/systemd/shutdown/scheduled ] && echo "POLARIS_REBOOT_AT=$(sed -n 's/^USEC=//p' /run/systemd/shutdown/scheduled)"; true`,
    "updates-on": `${DISTRO}; if command -v apt-get >/dev/null 2>&1; then export DEBIAN_FRONTEND=noninteractive; nice -n 10 apt-get update -qq >/dev/null && nice -n 10 apt-get install -y -qq unattended-upgrades >/dev/null && printf 'APT::Periodic::Update-Package-Lists "1";\\nAPT::Periodic::Unattended-Upgrade "1";\\n' > /etc/apt/apt.conf.d/20auto-upgrades && mkdir -p /etc/systemd/system/apt-daily-upgrade.timer.d && printf '[Timer]\\nOnCalendar=\\nOnCalendar=*-*-* 04:00\\nRandomizedDelaySec=30m\\n' > /etc/systemd/system/apt-daily-upgrade.timer.d/polaris.conf && { systemctl daemon-reload >/dev/null 2>&1 || true; } && echo POLARIS_UPDATES=on; elif command -v dnf >/dev/null 2>&1; then nice -n 10 dnf install -y -q dnf-automatic >/dev/null && sed -i -e 's/^upgrade_type *=.*/upgrade_type = security/' -e 's/^apply_updates *=.*/apply_updates = yes/' /etc/dnf/automatic.conf && mkdir -p /etc/systemd/system/dnf-automatic.timer.d && printf '[Timer]\\nOnCalendar=\\nOnCalendar=*-*-* 04:00\\nRandomizedDelaySec=30m\\n' > /etc/systemd/system/dnf-automatic.timer.d/polaris.conf && { systemctl daemon-reload >/dev/null 2>&1 || true; } && systemctl enable --now dnf-automatic.timer >/dev/null 2>&1 && echo POLARIS_UPDATES=on; else echo POLARIS_UPDATES=unsupported; fi`,
    "updates-off": `${DISTRO}; if command -v apt-get >/dev/null 2>&1; then printf 'APT::Periodic::Update-Package-Lists "0";\\nAPT::Periodic::Unattended-Upgrade "0";\\n' > /etc/apt/apt.conf.d/20auto-upgrades && echo POLARIS_UPDATES=off; elif command -v dnf >/dev/null 2>&1; then systemctl disable --now dnf-automatic.timer >/dev/null 2>&1; echo POLARIS_UPDATES=off; else echo POLARIS_UPDATES=unsupported; fi`,

    // Only when the host says a restart is pending; systemd announces it to every
    // session on the machine and can still be cancelled until it happens.
    "reboot-schedule": `${DISTRO}; if [ -f /var/run/reboot-required ] || { command -v needs-restarting >/dev/null 2>&1 && ! needs-restarting -r >/dev/null 2>&1; }; then shutdown -r 04:30 'Polaris: restarting at 04:30 to finish security updates' >/dev/null 2>&1 && echo POLARIS_REBOOT=scheduled; else echo POLARIS_REBOOT=none; fi; [ -f /run/systemd/shutdown/scheduled ] && echo "POLARIS_REBOOT_AT=$(sed -n 's/^USEC=//p' /run/systemd/shutdown/scheduled)"; true`,
    "reboot-cancel": `${DISTRO}; shutdown -c 'Polaris: the restart was cancelled' >/dev/null 2>&1; echo POLARIS_REBOOT=cancelled`,

    // The pending security updates, now: the same tool the automatic updates
    // run, so a held package stays where it is.
    // One package, kept where it is (a hold the automatic updates skip), let go,
    // or put back on a version the package manager still offers and then kept
    // there. The name and version are the script's own arguments, never part of it.
    "package-versions": `${DISTRO}; if command -v apt-get >/dev/null 2>&1; then dpkg -s "$1" 2>/dev/null | grep -q '^Status: install ok installed' || { echo POLARIS_PACKAGE=missing; exit 0; }; echo "POLARIS_INSTALLED=$(dpkg -s "$1" 2>/dev/null | sed -n 's/^Version: //p')"; apt-mark showhold 2>/dev/null | grep -qxF "$1" && echo POLARIS_KEPT=yes; apt-cache madison "$1" 2>/dev/null | awk -F'|' '{gsub(/ /, "", $2); if ($2 != "" && !seen[$2]++) print "POLARIS_VERSION=" $2}'; elif command -v dnf >/dev/null 2>&1; then rpm -q "$1" >/dev/null 2>&1 || { echo POLARIS_PACKAGE=missing; exit 0; }; echo "POLARIS_INSTALLED=$(rpm -q --qf '%|EPOCH?{%{EPOCH}:}:{}|%{VERSION}-%{RELEASE}' "$1" | head -n 1)"; dnf -q versionlock list 2>/dev/null | awk '/^Package name: / {print "POLARIS_HELD=" $3; next} /^#/ || / / || NF == 0 {next} {n = split($0, a, "-"); if (n > 2) {s = a[1]; for (i = 2; i <= n - 2; i++) s = s "-" a[i]; print "POLARIS_HELD=" s}}' | grep -qxF "POLARIS_HELD=$1" && echo POLARIS_KEPT=yes; dnf -q --showduplicates list "$1" 2>/dev/null | awk 'NF == 3 && !seen[$2]++ {print "POLARIS_VERSION=" $2}'; else echo POLARIS_PACKAGE=unsupported; fi; true`,
    "package-hold": `${DISTRO}; if command -v apt-get >/dev/null 2>&1; then dpkg -s "$1" 2>/dev/null | grep -q '^Status: install ok installed' || { echo POLARIS_HOLD=missing; exit 0; }; if apt-mark hold "$1" >/dev/null 2>&1; then echo POLARIS_HOLD=held; else echo POLARIS_HOLD=failed; fi; elif command -v dnf >/dev/null 2>&1; then rpm -q "$1" >/dev/null 2>&1 || { echo POLARIS_HOLD=missing; exit 0; }; if { dnf -q versionlock list >/dev/null 2>&1 || nice -n 10 dnf install -y -q 'dnf-command(versionlock)' >/dev/null 2>&1; } && dnf -q versionlock add "$1" >/dev/null 2>&1; then echo POLARIS_HOLD=held; else echo POLARIS_HOLD=failed; fi; else echo POLARIS_HOLD=unsupported; fi; true`,
    "package-unhold": `${DISTRO}; if command -v apt-get >/dev/null 2>&1; then if apt-mark unhold "$1" >/dev/null 2>&1; then echo POLARIS_HOLD=released; else echo POLARIS_HOLD=failed; fi; elif command -v dnf >/dev/null 2>&1; then dnf -q versionlock delete "$1" >/dev/null 2>&1; if dnf -q versionlock list 2>/dev/null | awk '/^Package name: / {print "POLARIS_HELD=" $3; next} /^#/ || / / || NF == 0 {next} {n = split($0, a, "-"); if (n > 2) {s = a[1]; for (i = 2; i <= n - 2; i++) s = s "-" a[i]; print "POLARIS_HELD=" s}}' | grep -qxF "POLARIS_HELD=$1"; then echo POLARIS_HOLD=failed; else echo POLARIS_HOLD=released; fi; else echo POLARIS_HOLD=unsupported; fi; true`,
    "package-rollback": `${DISTRO}; if command -v apt-get >/dev/null 2>&1; then export DEBIAN_FRONTEND=noninteractive; apt-cache madison "$1" 2>/dev/null | awk -F'|' '{gsub(/ /, "", $2); if ($2 != "" && !seen[$2]++) print "POLARIS_VERSION=" $2}' | grep -qxF "POLARIS_VERSION=$2" || { echo POLARIS_ROLLBACK=unavailable; exit 0; }; if nice -n 10 apt-get install -y -qq --no-remove --allow-downgrades -o Dpkg::Options::=--force-confold "$1=$2" >/dev/null 2>&1; then apt-mark hold "$1" >/dev/null 2>&1; echo POLARIS_ROLLBACK=done; else echo POLARIS_ROLLBACK=failed; fi; elif command -v dnf >/dev/null 2>&1; then dnf -q --showduplicates list "$1" 2>/dev/null | awk 'NF == 3 && !seen[$2]++ {print "POLARIS_VERSION=" $2}' | grep -qxF "POLARIS_VERSION=$2" || { echo POLARIS_ROLLBACK=unavailable; exit 0; }; if nice -n 10 dnf downgrade -y -q "$1-$2" >/dev/null 2>&1; then { dnf -q versionlock list >/dev/null 2>&1 || nice -n 10 dnf install -y -q 'dnf-command(versionlock)' >/dev/null 2>&1; }; dnf -q versionlock add "$1" >/dev/null 2>&1; echo POLARIS_ROLLBACK=done; else echo POLARIS_ROLLBACK=failed; fi; else echo POLARIS_ROLLBACK=unsupported; fi; true`,
    "packages-fix": `${DISTRO}; if command -v apt-get >/dev/null 2>&1; then export DEBIAN_FRONTEND=noninteractive; nice -n 10 apt-get update -qq >/dev/null 2>&1; if ! command -v unattended-upgrade >/dev/null 2>&1; then echo POLARIS_FIX=unavailable; elif nice -n 10 unattended-upgrade >/dev/null 2>&1; then echo POLARIS_FIX=done; else echo POLARIS_FIX=failed; fi; [ -f /var/run/reboot-required ] && echo POLARIS_REBOOT=required; elif command -v dnf >/dev/null 2>&1; then if nice -n 10 dnf upgrade --security -y -q >/dev/null 2>&1; then echo POLARIS_FIX=done; else echo POLARIS_FIX=failed; fi; command -v needs-restarting >/dev/null 2>&1 && { needs-restarting -r >/dev/null 2>&1 || echo POLARIS_REBOOT=required; }; else echo POLARIS_FIX=unsupported; fi; true`
};

/**
 * Where a package manager keeps what is installed, and the release file that
 * names the distribution, copied out of the host's root (read-only, no
 * network) as a tar. The matcher reads them as a directory, as an image's.
 */
export const PACKAGES_SCRIPT =
    'cd /host || exit 21; set --; for p in etc/os-release usr/lib/os-release var/lib/dpkg/status var/lib/rpm usr/lib/sysimage/rpm lib/apk/db/installed; do [ -e "$p" ] && set -- "$@" "$p"; done; [ "$#" -gt 0 ] || exit 22; exec tar -cf - "$@"';

/** The host's package database into an export volume, over SSH: `list | write`. */
export function packagesArgv(volume: string) {
    if (!isExportVolume(volume)) throw new Error("Not an export volume");
    return {
        list: [
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "--cpu-shares",
            "64",
            "--memory",
            "256m",
            "-v",
            "/:/host:ro",
            TOOLS_IMAGE,
            "/bin/sh",
            "-c",
            PACKAGES_SCRIPT
        ],
        write: [
            "docker",
            "run",
            "--rm",
            "-i",
            "--network",
            "none",
            "-v",
            `${volume}:/in`,
            TOOLS_IMAGE,
            "/bin/sh",
            "-c",
            "mkdir -p /in/root && tar -C /in/root -xf -"
        ],
        // A pipe's status is its last command's: an empty copy is the failure.
        check: [
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "-v",
            `${volume}:/in`,
            TOOLS_IMAGE,
            "/bin/sh",
            "-c",
            'test -n "$(ls -A /in/root 2>/dev/null)"'
        ]
    };
}

/** Vulnerabilities of the host's own packages, read from the copied database. */
export function hostVulnSpec(volume: string): ComposeSpec {
    if (!isExportVolume(volume)) throw new Error("Not an export volume");
    return spec(
        PROJECTS.images,
        service("polaris-secscan-match", VULN_IMAGE, {
            command: ["dir:/in/root", "-o", "json", "-q"],
            env: {
                GRYPE_DB_CACHE_DIR: "/cache/vulnerabilities",
                GRYPE_CHECK_FOR_APP_UPDATE: "false"
            },
            volumes: [
                { source: "cache", target: "/cache", kind: "volume" },
                { source: volume, target: "/in", kind: "volume" }
            ],
            memoryMb: 2048
        }),
        ["cache"],
        [volume]
    );
}

/** The container a host action runs in. One name, so two can never overlap. */
export const HOST_CONTAINER = "polaris-secscan-host";

/**
 * The `docker run` a host action is, as an argument list. The audit sees the
 * host read-only and changes nothing; the updates switch is the one place that
 * needs the host's root writable, its process tree, and its network.
 */
export function hostArgv(action: HostAction, words: readonly string[] = []): string[] {
    const base = ["docker", "run", "--rm", "--name", HOST_CONTAINER, "--cpu-shares", "64"];
    if (action === "audit") {
        return [
            ...base,
            "--memory",
            "512m",
            "-v",
            "/:/host:ro",
            TOOLS_IMAGE,
            "/bin/sh",
            "-c",
            AUDIT_SCRIPT
        ];
    }
    return [
        ...base,
        "--privileged",
        "--pid",
        "host",
        "--network",
        "host",
        "-v",
        "/:/host",
        TOOLS_IMAGE,
        "chroot",
        "/host",
        "/bin/sh",
        "-c",
        UPDATES_SCRIPTS[action],
        // A package action's name and version, as the script's own arguments.
        ...(words.length > 0 ? ["polaris", ...words] : [])
    ];
}
