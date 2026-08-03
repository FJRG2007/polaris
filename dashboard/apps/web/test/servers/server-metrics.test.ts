/**
 * Reading a server's own report of itself.
 *
 * The probe runs on somebody else's machine, so its output is untrusted in the
 * ordinary way: fields can be missing, `ps` and `docker` disagree about units, and
 * a busy box can answer with something nobody anticipated. What matters is that a
 * missing number stays missing instead of becoming NaN in front of an operator.
 */

import { describe, expect, it } from "vitest";
import { parseProbe } from "../../src/lib/server-probe";

const LINUX = [
    "os=Ubuntu 24.04.1 LTS",
    "kernel=6.8.0-51-generic",
    "cpus=8",
    "load=1.75",
    "mem_total=16777216000",
    "mem_available=8388608000",
    "disk_total=105086976000",
    "disk_used=59797504000",
    "container=polaris-web-56\t12.34%\t512MiB / 1.94GiB",
    "container=polaris-postgres-1\t3.10%\t128.5MiB / 1.94GiB",
    "process=99.0\t2048\tstress-ng",
    "process=0.4\t1024\tsshd"
].join("\n");

describe("parseProbe", () => {
    it("reads what the machine says it is", () => {
        const metrics = parseProbe(LINUX);
        expect(metrics.os).toBe("Ubuntu 24.04.1 LTS");
        expect(metrics.kernel).toBe("6.8.0-51-generic");
        expect(metrics.cpuCount).toBe(8);
        expect(metrics.loadAverage).toBe(1.75);
    });

    // Available rather than free: the used figure has to exclude the page cache,
    // or a healthy machine reads as nearly out of memory.
    it("reports memory as total minus available", () => {
        expect(parseProbe(LINUX).memoryUsedBytes).toBe(8388608000);
    });

    it("ranks whatever is heaviest first, container or process alike", () => {
        const consumers = parseProbe(LINUX).consumers;
        expect(consumers[0]).toMatchObject({ name: "stress-ng", kind: "process", cpuPercent: 99 });
        expect(consumers[1]).toMatchObject({ name: "polaris-web-56", kind: "container" });
    });

    // Docker picks the unit by size, so both spellings of every scale have to land
    // on the same axis as a process's KiB-based resident set.
    it("converts each side's memory units into bytes", () => {
        const consumers = parseProbe(LINUX).consumers;
        expect(consumers.find((entry) => entry.name === "polaris-web-56")?.memoryBytes).toBe(536870912);
        expect(consumers.find((entry) => entry.name === "polaris-postgres-1")?.memoryBytes).toBe(134742016);
        expect(consumers.find((entry) => entry.name === "sshd")?.memoryBytes).toBe(1048576);
    });

    // A box with no /proc, no docker and a ps that refused the flags. It is still a
    // reachable server, and the panel still has something true to show.
    it("keeps a field it could not read missing rather than guessing", () => {
        const metrics = parseProbe("os=Alpine Linux v3.20\nkernel=6.6.0\n");
        expect(metrics.os).toBe("Alpine Linux v3.20");
        expect(metrics.memoryTotalBytes).toBeNull();
        expect(metrics.memoryUsedBytes).toBeNull();
        expect(metrics.diskUsedBytes).toBeNull();
        expect(metrics.consumers).toEqual([]);
    });

    it("never turns unreadable output into NaN", () => {
        const metrics = parseProbe("cpus=\nload=n/a\nmem_total=oops\ncontainer=\t\t\n");
        expect(metrics.cpuCount).toBeNull();
        expect(metrics.loadAverage).toBeNull();
        expect(metrics.memoryTotalBytes).toBeNull();
        expect(metrics.consumers).toEqual([]);
    });

    it("ignores lines that are not a field", () => {
        const metrics = parseProbe("sh: 1: docker: not found\n=orphan\nos=Debian GNU/Linux 12 (bookworm)");
        expect(metrics.os).toBe("Debian GNU/Linux 12 (bookworm)");
    });
});
