/**
 * Reading what an update carries from GitHub: one comparison, paged and
 * bounded, newest first, with the severity taken from both the commits'
 * trailers and the vulnerability write-ups the range marks fixed. And the
 * quiet hour, from the deployment's own activity.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const github = vi.hoisted(() => vi.fn());
vi.mock("@/lib/update-service", () => ({ github }));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_REPO: "example/polaris" }) }));
const settings = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string) => void settings.set(key, value)
}));
const auditLog = vi.hoisted(() => ({ findMany: vi.fn(async () => [] as { at: Date }[]) }));
const session = vi.hoisted(() => ({ findMany: vi.fn(async () => [] as { createdAt: Date }[]) }));
vi.mock("@polaris/db", () => ({ prisma: { auditLog, session } }));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { updateChangelog, quietestHour, quietHour, DEFAULT_QUIET_HOUR } = await import(
    "@/lib/update-changelog"
);

function commit(sha: string, message: string) {
    return { sha, commit: { message } };
}

beforeEach(() => {
    vi.clearAllMocks();
    settings.clear();
});

describe("what an update carries", () => {
    it("lists the range newest first and takes the worst severity from trailers and write-ups", async () => {
        github.mockResolvedValueOnce({
            total_commits: 3,
            html_url: "https://github.com/example/polaris/compare/aaa...bbb",
            commits: [
                commit("1111111", "✨ feat(mail): older"),
                commit("2222222", "🐛 fix(vault): fix\n\nSecurity: medium"),
                commit("3333333", "🐛 fix(drive): newest")
            ],
            files: [
                { filename: "docs/vulnerabilities/VULN-0037-drive.md", status: "added" },
                { filename: "dashboard/apps/web/src/x.ts", status: "modified" }
            ]
        });
        fetchMock.mockResolvedValueOnce(
            new Response("---\nid: VULN-0037\nstatus: fixed\nseverity: critical\n---\n")
        );
        const log = await updateChangelog("aaa", "bbb");
        expect(log?.security).toBe("critical");
        expect(log?.fixes).toEqual([{ id: "VULN-0037", severity: "critical" }]);
        // Security first, then by kind (feature before fix), newest first within each.
        expect(log?.entries.map((entry) => entry.sha)).toEqual(["2222222", "1111111", "3333333"]);
        expect(String(fetchMock.mock.calls[0]![0])).toBe(
            "https://raw.githubusercontent.com/example/polaris/bbb/docs/vulnerabilities/VULN-0037-drive.md"
        );
        // Kept: the same pair is not asked for again.
        await updateChangelog("aaa", "bbb");
        expect(github).toHaveBeenCalledTimes(1);
    });

    it("reads at most five pages and counts the rest", async () => {
        const page = (offset: number) =>
            Array.from({ length: 100 }, (_, index) => commit(`p${offset + index}`, `fix(x): ${offset + index}`));
        github.mockImplementation(async (path: string) => {
            const n = Number(/page=(\d+)/.exec(path)![1]);
            return { total_commits: 900, commits: page((n - 1) * 100), files: [] };
        });
        const log = await updateChangelog("ccc", "ddd");
        expect(github).toHaveBeenCalledTimes(5);
        expect(log!.entries).toHaveLength(300);
        expect(log!.more).toBe(200 + 400);
    });

    it("answers nothing when GitHub cannot be reached, or there is no range", async () => {
        github.mockRejectedValueOnce(new Error("rate limit"));
        expect(await updateChangelog("eee", "fff")).toBeNull();
        expect(await updateChangelog(null, "fff")).toBeNull();
        expect(await updateChangelog("fff", "fff")).toBeNull();
    });
});

describe("the quietest hour", () => {
    it("is the hour with the least activity", () => {
        const moments = Array.from({ length: 24 * 5 }, (_, index) => new Date(2026, 10, 1, index % 24));
        // Hour 3 loses its events; every other hour keeps five.
        expect(quietestHour(moments.filter((moment) => moment.getHours() !== 3))).toBe(3);
    });

    it("falls back to the small hours with too little history", () => {
        expect(quietestHour([new Date()])).toBe(DEFAULT_QUIET_HOUR);
    });

    it("is worked out from the audit log and sign-ins, once a day", async () => {
        const busy = Array.from({ length: 60 }, (_, index) => ({ at: new Date(2026, 10, 1, 5 + (index % 18)) }));
        auditLog.findMany.mockResolvedValue(busy);
        const now = new Date(2026, 10, 12, 12);
        const hour = await quietHour(now);
        expect(hour).toBe(0);
        await quietHour(now);
        expect(auditLog.findMany).toHaveBeenCalledTimes(1);
    });
});
