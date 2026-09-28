/**
 * The data of deleted apps, removed without anybody pressing a button.
 *
 * What is pinned: only a volume the storage screen judges safe goes, never one
 * it says to check or keep; the removal is audited and the people who manage the
 * server are told once, with what went; a volume the daemon refuses is neither
 * counted nor announced; and the switch on the storage screen stops all of it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
    volumes: [] as {
        name: string;
        bytes: number | null;
        project: string | null;
        description: string | null;
        verdict: "keep" | "review" | "safe";
        reason: string;
    }[],
    refuse: new Set<string>(),
    removed: [] as string[],
    audits: [] as { action: string; targetId?: string; actorId: string | null }[],
    alerts: [] as { title: string; body: string }[],
    setting: null as string | null,
    settingFails: false,
    strict: [] as (boolean | undefined)[]
}));

vi.mock("@/lib/deploy/host-volumes", () => ({
    hostVolumes: async (options?: { strict?: boolean }) => {
        fake.strict.push(options?.strict);
        return fake.volumes;
    },
    removeHostVolume: async (name: string) => {
        if (fake.refuse.has(name)) return { ok: false, reason: "Something is using it now." };
        fake.removed.push(name);
        return { ok: true };
    }
}));
vi.mock("@/lib/audit-service", () => ({
    recordAudit: async (event: { action: string; targetId?: string; actorId: string | null }) => {
        fake.audits.push(event);
    }
}));
vi.mock("@/lib/setting-store", () => ({
    getSetting: async () => {
        if (fake.settingFails) throw new Error("database unavailable");
        return fake.setting;
    },
    setSetting: async (_key: string, value: string | null) => {
        fake.setting = value;
    }
}));
vi.mock("@/lib/notifications/operators", () => ({
    notifyOperators: async (alert: { title: string; body: string }) => {
        fake.alerts.push(alert);
    }
}));

const { removeLeftoverVolumes, setAutoRemove } = await import("@/lib/deploy/leftover-volumes");

const volume = (name: string, verdict: "keep" | "review" | "safe", bytes = 300 * 1024 * 1024) => ({
    name,
    bytes,
    project: name.replace(/_data$/, ""),
    description: verdict === "safe" ? `Data of ${name}` : null,
    verdict,
    reason: ""
});

beforeEach(() => {
    Object.assign(fake, {
        volumes: [],
        refuse: new Set(),
        removed: [],
        audits: [],
        alerts: [],
        setting: null,
        settingFails: false,
        strict: []
    });
});

describe("removing leftover volumes", () => {
    it("removes only what is judged safe, and says so once", async () => {
        fake.volumes = [
            volume("polaris-36e74d11_data", "safe"),
            volume("polaris-b8d17535_data", "safe"),
            volume("polaris-mod-gradle", "review"),
            volume("polaris-ad8d46ef_data", "keep")
        ];
        const removed = await removeLeftoverVolumes();
        expect(removed.map((one) => one.name)).toEqual([
            "polaris-36e74d11_data",
            "polaris-b8d17535_data"
        ]);
        expect(fake.removed).toEqual(["polaris-36e74d11_data", "polaris-b8d17535_data"]);
        expect(fake.audits).toEqual([
            expect.objectContaining({
                action: "server.volume.removed",
                actorId: null,
                targetId: "polaris-36e74d11_data"
            }),
            expect.objectContaining({
                action: "server.volume.removed",
                actorId: null,
                targetId: "polaris-b8d17535_data"
            })
        ]);
        expect(fake.alerts).toHaveLength(1);
        expect(fake.alerts[0]!.title).toBe("Polaris removed 2 leftover volumes (600.0 MB)");
    });

    it("counts nothing the daemon refused, and says nothing when nothing went", async () => {
        fake.volumes = [volume("polaris-36e74d11_data", "safe")];
        fake.refuse.add("polaris-36e74d11_data");
        expect(await removeLeftoverVolumes()).toEqual([]);
        expect(fake.audits).toEqual([]);
        expect(fake.alerts).toEqual([]);
    });

    it("does nothing at all while switched off", async () => {
        fake.volumes = [volume("polaris-36e74d11_data", "safe")];
        await setAutoRemove(false);
        expect(await removeLeftoverVolumes()).toEqual([]);
        expect(fake.removed).toEqual([]);
        await setAutoRemove(true);
        expect(fake.setting).toBeNull();
        expect(await removeLeftoverVolumes()).toHaveLength(1);
    });

    it("judges from records it could read, never from ones it could not", async () => {
        fake.volumes = [volume("polaris-36e74d11_data", "safe")];
        await removeLeftoverVolumes();
        expect(fake.strict).toEqual([true]);
    });

    it("skips the pass when the switch cannot be read", async () => {
        fake.volumes = [volume("polaris-36e74d11_data", "safe")];
        fake.settingFails = true;
        await expect(removeLeftoverVolumes()).rejects.toThrow();
        expect(fake.removed).toEqual([]);
        expect(fake.alerts).toEqual([]);
    });
});
