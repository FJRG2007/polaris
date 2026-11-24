/**
 * Apps taking their own releases in the background: what each release gets
 * decided, that each one is announced once, that a release asking for more
 * than was accepted waits for an administrator, and that one which does not
 * keep running is put back and not tried by itself again.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppReleaseStatus } from "@/lib/app-bundles/releases";

const settings = new Map<string, string>();
vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string | null) => {
        if (value === null) settings.delete(key);
        else settings.set(key, value);
    }
}));
vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/apps/catalog", () => ({
    findApp: (id: string) => ({ id, name: `App ${id}`, settingsAt: "/x/settings" })
}));
vi.mock("@/lib/notifications/operators", () => ({ notifyOperators: async () => undefined }));
vi.mock("@/lib/app-bundles/releases", () => ({
    appReleaseStatuses: async () => [],
    updateApp: async () => ({ ok: true, changed: true }),
    rollbackApp: async () => ({ ok: true, changed: true })
}));
vi.mock("@/lib/app-bundles/loader", () => ({ loadedBundle: () => null }));
vi.mock("@/lib/app-bundles/lifecycle", () => ({ appFailure: () => null }));
vi.mock("@/lib/app-bundles/store", () => ({ readBundleState: async () => null }));

const auto = await import("@/lib/app-bundles/auto-update");

const OLD = `sha256:${"a".repeat(64)}`;
const NEW = `sha256:${"b".repeat(64)}`;

function status(over: Partial<AppReleaseStatus> = {}, permissions: string[] = []): AppReleaseStatus {
    return {
        id: "tiny",
        running: true,
        installed: { digest: OLD, source: "registry", version: "1.0.0" },
        previous: null,
        available: { digest: NEW, size: 10, version: "1.1.0", notes: "Faster.", permissions, runs: true },
        checkFailed: false,
        progress: null,
        ...over
    };
}

function deps(over: Partial<auto.PassDeps> = {}, statuses = [status()]) {
    const told: { event: string; title: string; body: string }[] = [];
    const calls = { update: 0, rollback: 0 };
    const t = ((key: string, values?: Record<string, unknown>) =>
        `${key}${values ? ` ${JSON.stringify(values)}` : ""}`) as never;
    const d: auto.PassDeps = {
        statuses: async () => statuses,
        update: async () => {
            calls.update++;
            return { ok: true, changed: true };
        },
        rollback: async () => {
            calls.rollback++;
            return { ok: true, changed: true };
        },
        healthy: async () => true,
        recipients: async () => ["admin-1"],
        tell: async ({ event, say }) => {
            told.push({ event, ...say(t) });
        },
        ...over
    };
    return { d, told, calls };
}

beforeEach(() => settings.clear());

describe("decideAppUpdate", () => {
    const base = {
        installed: OLD,
        available: { digest: NEW, runs: true, permissions: [] as string[] },
        auto: true,
        accepted: [] as string[],
        failed: [] as string[]
    };

    it("applies a newer release that runs and asks for nothing new", () => {
        expect(auto.decideAppUpdate(base).decision).toBe("apply");
    });
    it("does nothing when the release is the one installed, or there is none", () => {
        expect(auto.decideAppUpdate({ ...base, available: { ...base.available, digest: OLD } }).decision).toBe("current");
        expect(auto.decideAppUpdate({ ...base, available: null }).decision).toBe("current");
        expect(auto.decideAppUpdate({ ...base, installed: null }).decision).toBe("current");
    });
    it("leaves a release that needs a newer Polaris to the dashboard's update", () => {
        expect(auto.decideAppUpdate({ ...base, available: { ...base.available, runs: false } }).decision).toBe("needsPolaris");
    });
    it("waits when automatic updates are off", () => {
        expect(auto.decideAppUpdate({ ...base, auto: false }).decision).toBe("manual");
    });
    it("holds a release asking for permissions never accepted, even with auto on", () => {
        const held = auto.decideAppUpdate({
            ...base,
            available: { ...base.available, permissions: ["mcp:drive.read", "net"] },
            accepted: ["net"]
        });
        expect(held).toEqual({ decision: "permissions", newPermissions: ["mcp:drive.read"] });
    });
    it("does not retry a release that failed here", () => {
        expect(auto.decideAppUpdate({ ...base, failed: [NEW] }).decision).toBe("failedBefore");
    });
    it("per-app override wins over the switch for all", () => {
        expect(auto.autoFor({ auto: true, apps: { tiny: false } }, "tiny")).toBe(false);
        expect(auto.autoFor({ auto: false, apps: {} }, "tiny")).toBe(false);
        expect(auto.autoFor({ auto: false, apps: { tiny: true } }, "tiny")).toBe(true);
        expect(auto.autoFor(auto.DEFAULT_POLICY, "tiny")).toBe(true);
    });
});

describe("runAppUpdatePass", () => {
    it("updates by default, with no setting written beforehand, and says so once", async () => {
        const { d, told, calls } = deps();
        const first = await auto.runAppUpdatePass(d);
        expect(first.applied).toEqual(["tiny"]);
        expect(calls.update).toBe(1);
        expect(told.map((one) => one.event)).toEqual(["apps.updated"]);
        expect(told[0]!.body).toContain("Faster.");
    });

    it("announces a release waiting on a person once, however many passes see it", async () => {
        await auto.writeAppUpdatePolicy({ auto: false, apps: {} });
        const { d, told, calls } = deps();
        await auto.runAppUpdatePass(d);
        await auto.runAppUpdatePass(d);
        await auto.runAppUpdatePass(d);
        expect(calls.update).toBe(0);
        expect(told).toHaveLength(1);
        expect(told[0]!.event).toBe("apps.update");
        expect(told[0]!.body).toContain("appUpdate.planManual");
        expect(await auto.appsWaitingOnUpdate()).toEqual(["tiny"]);
    });

    it("holds a release that asks for new permissions and names them", async () => {
        const { d, told, calls } = deps({}, [status({}, ["mcp:drive.read"])]);
        const report = await auto.runAppUpdatePass(d);
        expect(calls.update).toBe(0);
        expect(report.waiting).toEqual(["tiny"]);
        expect(told[0]!.body).toContain("mcp:drive.read");
    });

    it("accepts what the installed release already asked for, for an install from before", async () => {
        const installed = { digest: OLD, source: "registry" as const, permissions: ["net"] };
        const { d, calls } = deps({}, [status({ installed }, ["net"])]);
        await auto.runAppUpdatePass(d);
        expect(calls.update).toBe(1);
    });

    it("puts back a release that does not keep running and does not try it again", async () => {
        const { d, told, calls } = deps({ healthy: async () => false });
        const report = await auto.runAppUpdatePass(d);
        expect(report.rolledBack).toEqual(["tiny"]);
        expect(calls.rollback).toBe(1);
        expect(told[0]!.title).toContain("appUpdate.rolledBackTitle");
        const again = await auto.runAppUpdatePass(d);
        expect(calls.update).toBe(1);
        expect(again.waiting).toEqual(["tiny"]);
        // The hold was announced with the rollback; nothing more is said.
        expect(told).toHaveLength(1);
    });

    it("retries an unreachable registry without a word or a hold", async () => {
        const { d, told } = deps({ update: async () => ({ ok: false, code: "unreachable" }) });
        const report = await auto.runAppUpdatePass(d);
        expect(report.unreachable).toBe(true);
        expect(report.waiting).toEqual([]);
        expect(told).toHaveLength(0);
    });

    it("holds a release that would not start, and says so", async () => {
        const { d, told } = deps({ update: async () => ({ ok: false, code: "failed" }) });
        await auto.runAppUpdatePass(d);
        expect(told[0]!.title).toContain("appUpdate.failedTitle");
        expect(await auto.appsWaitingOnUpdate()).toEqual(["tiny"]);
    });
});

describe("nextPass", () => {
    it("waits six hours after a good pass and backs off from five minutes otherwise", () => {
        expect(auto.nextPass(0, false, 999)).toEqual({ nextAt: auto.PASS_EVERY_MS, retryMs: auto.RETRY_FROM_MS });
        const first = auto.nextPass(0, true, auto.RETRY_FROM_MS);
        expect(first).toEqual({ nextAt: auto.RETRY_FROM_MS, retryMs: auto.RETRY_FROM_MS * 2 });
        expect(auto.nextPass(0, true, auto.PASS_EVERY_MS * 4).nextAt).toBe(auto.PASS_EVERY_MS);
    });
});
