import { describe, expect, it } from "vitest";

import type { UnasMetrics } from "@/lib/unifi-unas";
import * as control from "@/lib/unifi-unas-control";

const NOW = new Date("2026-10-20T12:00:00Z");

function metrics(overrides: Partial<UnasMetrics> = {}): UnasMetrics {
    return {
        totalBytes: 100,
        usedBytes: 50,
        pools: [
            {
                device: "md3",
                totalBytes: 100,
                usedBytes: 50,
                health: "healthy",
                raidLevel: "raid5",
                raidState: "clean",
                membersPresent: 4,
                membersExpected: 4,
                reasons: []
            }
        ],
        disks: [
            {
                slot: 1,
                present: true,
                state: "normal",
                model: "m",
                serial: "s",
                type: "HDD",
                sizeBytes: 1,
                temperature: 38,
                healthy: true,
                rpm: 7200,
                powerOnHours: 10
            },
            {
                slot: 2,
                present: false,
                state: "nodisk",
                model: null,
                serial: null,
                type: null,
                sizeBytes: 0,
                temperature: null,
                healthy: false,
                rpm: null,
                powerOnHours: null
            }
        ],
        slotsTotal: 2,
        slotsPopulated: 1,
        health: "healthy",
        system: {
            name: "n",
            model: "UNAS",
            firmware: "",
            cpuTemp: null,
            cpuLoad: null,
            memoryUsedBytes: 0,
            memoryTotalBytes: 0,
            uptimeSeconds: 0
        },
        raw: {},
        ...overrides
    };
}

describe("unifi-unas-control", () => {
    it("parses the fan profile wherever the API puts it", () => {
        expect(control.parseFanProfile({ profile: "quiet" })).toBe("quiet");
        expect(control.parseFanProfile({ data: { profile: "default" } })).toBe("balanced");
        expect(control.parseFanProfile({ mode: "Cooling" })).toBe("cooling");
        expect(control.parseFanProfile({ profile: "turbo" })).toBeNull();
        expect(control.parseFanProfile(null)).toBeNull();
    });

    it("parses backup tasks and skips entries without an id", () => {
        const tasks = control.parseBackupTasks({
            data: [
                {
                    id: "t1",
                    name: "Nightly",
                    schedule: { enable: true },
                    nextBackup: "2026-10-20T10:00:00Z",
                    lastTaskRun: { status: "idle", errorCodes: ["E2"] },
                    remote: { type: "s3" }
                },
                { name: "no id" }
            ]
        });
        expect(tasks).toHaveLength(1);
        expect(tasks[0]).toMatchObject({
            id: "t1",
            scheduleEnabled: true,
            errorCodes: ["E2"],
            remoteType: "s3"
        });
        expect(control.backupFailed(tasks[0])).toBe(true);
        expect(control.backupOverdue(tasks[0], NOW)).toBe(true);
        expect(control.backupOverdue({ ...tasks[0], lastStatus: "in-progress" }, NOW)).toBe(false);
        expect(control.backupOverdue({ ...tasks[0], scheduleEnabled: false }, NOW)).toBe(false);
        expect(control.parseBackupTasks("junk")).toEqual([]);
    });

    it("reports no alerts for a healthy NAS and ignores empty bays", () => {
        expect(control.unasAlerts(metrics(), [], NOW)).toEqual([]);
    });

    it("reports each alert condition once per subject", () => {
        const sick = metrics({
            pools: [
                { ...metrics().pools[0], usedBytes: 90, membersPresent: 3, raidState: "degraded" }
            ],
            disks: [{ ...metrics().disks[0], healthy: false, temperature: 55 }]
        });
        const kinds = control
            .unasAlerts(sick, [], NOW, { usagePercent: 85, diskTemperature: 50 })
            .map((a) => a.kind);
        expect(kinds).toEqual([
            "pool-unprotected",
            "pool-usage",
            "disk-unhealthy",
            "disk-temperature"
        ]);
    });

    it("leaves a pool built without redundancy alone, and reports one that lost a member", () => {
        for (const raidLevel of [null, "raid0", "none"]) {
            const single = metrics({ pools: [{ ...metrics().pools[0], raidLevel }] });
            expect(control.unasAlerts(single, [], NOW)).toEqual([]);
        }
        const lost = metrics({ pools: [{ ...metrics().pools[0], membersPresent: 3 }] });
        expect(control.unasAlerts(lost, [], NOW).map((a) => a.kind)).toEqual(["pool-unprotected"]);
    });

    it("newAlerts returns only conditions that just started", () => {
        const a = { kind: "disk-unhealthy" as const, key: "disk:1", subject: "1", value: null };
        const b = { kind: "pool-usage" as const, key: "usage:md3", subject: "md3", value: 90 };
        expect(control.newAlerts([a], [a, b])).toEqual([b]);
        expect(control.newAlerts([a, b], [a])).toEqual([]);
    });
});
