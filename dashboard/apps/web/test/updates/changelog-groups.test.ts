import { describe, expect, it } from "vitest";
import { parseCommit, type ChangelogEntry } from "@polaris/core";
import { groupChangelog, isMaintenance, shipsElsewhere } from "@/lib/changelog-groups";

function entry(subject: string, body = ""): ChangelogEntry {
    const parsed = parseCommit(subject.length.toString(16).padStart(7, "0"), `${subject}\n\n${body}`);
    if (!parsed) throw new Error(`hidden by core: ${subject}`);
    return parsed;
}

describe("isMaintenance", () => {
    it("takes a real type on an internal scope", () => {
        expect(isMaintenance(entry("🐛 fix(ci): the cache key misses the lockfile"))).toBe(true);
        expect(isMaintenance(entry("🐛 fix(test): wait for the dialog"))).toBe(true);
        expect(isMaintenance(entry("✨ feat(tests, ci): shard the suite"))).toBe(true);
    });

    it("takes subjects about the main branch and its guards", () => {
        expect(isMaintenance(entry("🐛 fix(ui): the guards that broke main"))).toBe(true);
        expect(isMaintenance(entry("🐛 fix(chat): main is green again"))).toBe(true);
        expect(isMaintenance(entry("🐛 fix(drive): flaky tests around uploads"))).toBe(true);
    });

    it("keeps what an operator would notice", () => {
        expect(isMaintenance(entry("✨ feat(automations): run on a schedule"))).toBe(false);
        expect(isMaintenance(entry("🐛 fix(minecraft): the guards spawn at the gate"))).toBe(false);
        expect(isMaintenance(entry("🐛 fix: the main menu opens on a tap"))).toBe(false);
        expect(isMaintenance(entry("🐛 fix(mail, ci): replies keep the thread"))).toBe(false);
    });

    it("never files a security fix as maintenance", () => {
        expect(isMaintenance(entry("🐛 fix(ci): token leaked in logs", "Security: high"))).toBe(false);
    });
});

describe("groupChangelog", () => {
    it("orders security first and maintenance last, leaving empty groups out", () => {
        const groups = groupChangelog([
            entry("🐛 fix(ci): pin the runner"),
            entry("✨ feat(mail): snooze"),
            entry("🐛 fix(vault): share link expiry", "Security: medium"),
            entry("🐛 fix(chat): unread badge")
        ]);
        expect(groups.map((group) => group.group)).toEqual(["security", "feature", "fix", "maintenance"]);
        expect(groups[3]!.entries.map((item) => item.scope)).toEqual(["ci"]);
    });
});

describe("shipsElsewhere", () => {
    it("leaves out what the website, desktop and extension release on their own", () => {
        expect(shipsElsewhere(entry("✨ feat(site): Copy page beside the docs"))).toBe(true);
        expect(shipsElsewhere(entry("🐛 fix(desktop): a right-click menu"))).toBe(true);
        expect(shipsElsewhere(entry("✨ feat(extension, streamdeck): new key"))).toBe(true);
        expect(groupChangelog([entry("✨ feat(site): a new page")])).toEqual([]);
    });

    it("keeps a change that also touches this server, and any security fix", () => {
        expect(shipsElsewhere(entry("✨ feat(site, mail): shared cards"))).toBe(false);
        expect(shipsElsewhere(entry("🐛 fix(mail): replies keep the thread"))).toBe(false);
        expect(shipsElsewhere(entry("🐛 fix(desktop): token in logs", "Security: high"))).toBe(false);
    });
});
