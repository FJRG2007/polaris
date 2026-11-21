/**
 * The changelog of an update stays readable after it is installed, and the
 * update on offer is read only up to the build Update would pull.
 *
 * - The available range ends at `status.latest` - the commit the published
 *   image was built from - and nothing is listed unless that image can be
 *   installed, so a commit the branch holds but no image carries never shows.
 * - The build an install starts from is recorded, and the next build settles
 *   it into the range it was installed over; a later install that fails keeps
 *   that range, and one with nothing recorded is unknown rather than guessed.
 * - The installed range ends at the running build and the available one
 *   starts there, so the two never overlap.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string | null) => {
        if (value === null) settings.delete(key);
        else settings.set(key, value);
    }
}));
const env = vi.hoisted(() => ({ POLARIS_BUILD_SHA: "", POLARIS_REPO: "example/polaris" }));
vi.mock("@polaris/config", () => ({ loadEnv: () => env }));
vi.mock("@/lib/session", () => ({ requireAdmin: async () => ({ id: "admin-1", isAdmin: true }) }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: vi.fn() }));
const updateChangelog = vi.hoisted(() =>
    vi.fn(async (base: string | null, head: string | null) => ({ base, head, entries: [], url: "" }))
);
vi.mock("@/lib/update-changelog", () => ({
    DEFAULT_QUIET_HOUR: 4,
    getSecurityUpdatePolicy: vi.fn(),
    saveSecurityUpdatePolicy: vi.fn(),
    quietHour: async () => 3,
    updateChangelog
}));
vi.mock("@/lib/update-watcher", () => ({
    getAutoUpdatePolicy: vi.fn(),
    saveAutoUpdatePolicy: vi.fn(),
    startUpdate: vi.fn()
}));
const getUpdateStatus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/update-service", () => ({ getUpdateStatus, resetUpdateStatus: vi.fn() }));
vi.mock("@/lib/update-source", () => ({ saveUpdateSource: vi.fn() }));
vi.mock("@/lib/update-report", () => ({ collectUpdateReport: vi.fn(), issueUrl: vi.fn() }));
vi.mock("@/lib/security/own-images", () => ({ ownVulnerabilities: vi.fn() }));

const { updateChangelogAction, installedChangelogAction } = await import("@/app/(app)/admin/updates/actions");
const { recordInstallFrom, settleInstalled, installedRange } = await import("@/lib/update-installed");

const OLD = "aaaaaaa" + "1".repeat(33);
const NOW = "bbbbbbb" + "2".repeat(33);
const NEXT = "ccccccc" + "3".repeat(33);

beforeEach(() => {
    vi.clearAllMocks();
    settings.clear();
    env.POLARIS_BUILD_SHA = "";
});

describe("the update on offer", () => {
    it("ends at the published image's commit, never the branch head", async () => {
        getUpdateStatus.mockResolvedValueOnce({ phase: "available", current: "bbbbbbb", latest: "ccccccc" });
        await updateChangelogAction();
        expect(updateChangelog).toHaveBeenCalledWith("bbbbbbb", "ccccccc");
    });

    it.each(["building", "blocked", "up-to-date", "unknown"])("lists nothing while %s", async (phase) => {
        getUpdateStatus.mockResolvedValueOnce({ phase, current: "bbbbbbb", latest: "ccccccc" });
        expect(await updateChangelogAction()).toBeNull();
        expect(updateChangelog).not.toHaveBeenCalled();
    });
});

describe("the update installed", () => {
    it("is the build the install started from to the one now running", async () => {
        env.POLARIS_BUILD_SHA = OLD;
        await recordInstallFrom(OLD);
        // The restart: the new build is the one answering now.
        env.POLARIS_BUILD_SHA = NOW;
        const installed = await installedChangelogAction();
        expect(installed.from).toBe("aaaaaaa");
        expect(installed.to).toBe("bbbbbbb");
        expect(updateChangelog).toHaveBeenCalledWith("aaaaaaa", "bbbbbbb", "installed");
        // Settled into its own row; the start is spent.
        expect(settings.get("updates.installFrom")).toBeUndefined();
        expect(settings.get("updates.lastInstalled")).toMatch(new RegExp(`^${OLD} ${NOW} `));
    });

    it("survives a later install that starts and never lands", async () => {
        await recordInstallFrom(OLD);
        await settleInstalled(NOW);
        // The next install starts from the running build, then fails: still NOW.
        await recordInstallFrom(NOW);
        expect(await installedRange(NOW)).toEqual({ from: "aaaaaaa", to: "bbbbbbb" });
    });

    it("moves on when the next install lands", async () => {
        await recordInstallFrom(OLD);
        await recordInstallFrom(NOW);
        expect(await installedRange(NEXT)).toEqual({ from: "bbbbbbb", to: "ccccccc" });
    });

    it("is unknown when no previous build was recorded, rather than a guessed range", async () => {
        env.POLARIS_BUILD_SHA = NOW;
        const installed = await installedChangelogAction();
        expect(installed).toEqual({ from: null, to: "bbbbbbb", changelog: null });
        expect(updateChangelog).not.toHaveBeenCalled();
    });

    it("takes the build the last update check was made by when no start was recorded", async () => {
        await settleInstalled(NOW, "aaaaaaa");
        expect(await installedRange(NOW)).toEqual({ from: "aaaaaaa", to: "bbbbbbb" });
        // A witness naming the running build itself is no range.
        settings.clear();
        await settleInstalled(NOW, "bbbbbbb");
        expect(await installedRange(NOW)).toEqual({ from: null, to: "bbbbbbb" });
    });

    it("prefers the recorded start over the witness", async () => {
        await recordInstallFrom(OLD);
        await settleInstalled(NOW, "9999999");
        expect(await installedRange(NOW)).toEqual({ from: "aaaaaaa", to: "bbbbbbb" });
    });
});

describe("installed and available together", () => {
    it("meet at the running build and never overlap", async () => {
        await recordInstallFrom(OLD);
        env.POLARIS_BUILD_SHA = NOW;
        getUpdateStatus.mockResolvedValueOnce({ phase: "available", current: "bbbbbbb", latest: "ccccccc" });
        const installed = await installedChangelogAction();
        await updateChangelogAction();
        expect(updateChangelog.mock.calls).toEqual([
            ["aaaaaaa", "bbbbbbb", "installed"],
            ["bbbbbbb", "ccccccc"]
        ]);
        expect(installed.to).toBe("bbbbbbb");
    });
});
