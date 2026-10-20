import { describe, expect, it } from "vitest";
import * as dns from "@/lib/dns-blocker/settings";
import { exportSettings, readImport } from "@/lib/dns-blocker/transfer";

const saved: dns.DnsSettings = { ...dns.DEFAULT_DNS_SETTINGS, deny: ["ads.example.com"] };

function file(settings: Record<string, unknown>): string {
    return JSON.stringify({ format: "polaris-dns-blocker", version: 1, settings });
}

describe("settings export and import", () => {
    it("reads its own export back as no change", () => {
        expect(readImport(exportSettings(saved), saved)).toEqual({
            ok: true,
            settings: saved,
            changed: []
        });
    });

    it("names what an import changes, and keeps what an older file lacks", () => {
        const result = readImport(file({ logDays: 14, safeSearch: true }), saved);
        expect(result.ok && result.changed).toEqual(["logDays", "safeSearch"]);
        expect(result.ok && result.settings.deny).toEqual(["ads.example.com"]);
    });

    it("refuses a file that is not an export, and names a setting that is wrong", () => {
        expect(readImport("not json", saved)).toMatchObject({ ok: false, error: "notJson" });
        expect(readImport(JSON.stringify({ settings: {} }), saved)).toMatchObject({
            ok: false,
            error: "notExport"
        });
        expect(readImport(file({ logDays: 9999, deny: ["/(?=x)/"] }), saved)).toEqual({
            ok: false,
            error: "invalid",
            fields: expect.arrayContaining(["logDays"])
        });
    });

    it("does not name what the form never holds as a change", () => {
        const other = { serviceDomains: { youtube: ["youtube.com"] }, timeZone: "Europe/Madrid" };
        expect(readImport(file(other), saved)).toMatchObject({ ok: true, changed: [] });
        const scheduled = readImport(
            file({ ...other, schedules: [{ lists: ["ads"], days: ["mon"], start: "", end: "" }] }),
            saved
        );
        expect(scheduled.ok && scheduled.changed).toEqual(["schedules", "timeZone"]);
    });

    it("ignores keys it does not know", () => {
        const result = readImport(file({ shell: "rm -rf /", logDays: 7 }), saved);
        expect(result.ok && result.changed).toEqual([]);
        expect(result.ok && "shell" in result.settings).toBe(false);
    });
});
