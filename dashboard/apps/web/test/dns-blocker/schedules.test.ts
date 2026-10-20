/**
 * Schedules: hours typed in the operator's zone, written for an engine whose
 * clock is UTC. Every shift across midnight and across the week is pinned here,
 * as is what the engine refuses (a schedule for a list it does not have).
 */

import { describe, expect, it } from "vitest";
import * as dns from "@/lib/dns-blocker/settings";
import * as render from "@/lib/dns-blocker/render";
import { engineSchedules, zoneOffsetMinutes } from "@/lib/dns-blocker/schedules";

const SUMMER = new Date("2026-07-01T12:00:00Z");
const WINTER = new Date("2026-01-15T12:00:00Z");
const SOCIAL = new Set(["social", "ads"]);

function schedule(patch: Partial<dns.DnsSchedule> = {}): dns.DnsSchedule {
    return { lists: ["social"], days: ["mon"], start: "21:00", end: "07:00", ...patch };
}

describe("zoneOffsetMinutes", () => {
    it("follows the zone's offset through the year", () => {
        expect(zoneOffsetMinutes("Europe/Madrid", SUMMER)).toBe(120);
        expect(zoneOffsetMinutes("Europe/Madrid", WINTER)).toBe(60);
        expect(zoneOffsetMinutes("America/New_York", SUMMER)).toBe(-240);
        expect(zoneOffsetMinutes("Asia/Kolkata", SUMMER)).toBe(330);
    });

    it("reads no zone or an unknown one as UTC", () => {
        expect(zoneOffsetMinutes("", SUMMER)).toBe(0);
        expect(zoneOffsetMinutes("Mars/Olympus", SUMMER)).toBe(0);
    });
});

describe("engineSchedules", () => {
    it("moves an overnight window to UTC on the same days", () => {
        const days: dns.DnsWeekday[] = ["mon", "tue", "wed", "thu", "fri"];
        expect(engineSchedules([schedule({ days })], "Europe/Madrid", SOCIAL, SUMMER)).toEqual({
            schedules: { "polaris-1-1": { weekdays: days, start: "19:00", end: "05:00" } },
            listSchedules: { social: ["polaris-1-1"] }
        });
    });

    it("moves a window that starts after local midnight to the day before", () => {
        const out = engineSchedules(
            [schedule({ days: ["mon"], start: "01:00", end: "03:00" })],
            "Europe/Madrid",
            SOCIAL,
            SUMMER
        );
        expect(out?.schedules).toEqual({
            "polaris-1-1": { weekdays: ["sun"], start: "23:00", end: "01:00" }
        });
    });

    it("moves a window west of UTC into the next day, wrapping the week", () => {
        const out = engineSchedules(
            [schedule({ days: ["sun"], start: "22:00", end: "23:30" })],
            "America/New_York",
            SOCIAL,
            SUMMER
        );
        expect(out?.schedules).toEqual({
            "polaris-1-1": { weekdays: ["mon"], start: "02:00", end: "03:30" }
        });
    });

    it("splits a whole local day in two when the zone is not UTC", () => {
        const out = engineSchedules(
            [schedule({ days: ["sat", "sun"], start: "", end: "" })],
            "Europe/Madrid",
            SOCIAL,
            SUMMER
        );
        expect(out?.schedules).toEqual({
            "polaris-1-1": { weekdays: ["fri", "sat"], start: "22:00", end: "00:00" },
            "polaris-1-2": { weekdays: ["sat", "sun"], start: "00:00", end: "22:00" }
        });
    });

    it("keeps a whole day whole in UTC", () => {
        const out = engineSchedules(
            [schedule({ days: ["sat"], start: "", end: "" })],
            "",
            SOCIAL,
            SUMMER
        );
        expect(out?.schedules).toEqual({ "polaris-1-1": { weekdays: ["sat"] } });
    });

    it("leaves out lists the engine does not have, and is null when none are left", () => {
        expect(
            engineSchedules([schedule({ lists: ["gambling"] })], "UTC", SOCIAL, SUMMER)
        ).toBeNull();
        const out = engineSchedules(
            [schedule({ lists: ["gambling", "ads"] }), schedule({ lists: ["ads"] })],
            "UTC",
            SOCIAL,
            SUMMER
        );
        expect(out?.listSchedules).toEqual({ ads: ["polaris-1-1", "polaris-2-1"] });
    });
});

describe("rendered schedules", () => {
    const settings = (patch: Partial<dns.DnsSettings> = {}): dns.DnsSettings => ({
        ...dns.DEFAULT_DNS_SETTINGS,
        sources: ["hagezi-pro", "hagezi-social"],
        schedules: [schedule()],
        timeZone: "Europe/Madrid",
        ...patch
    });
    const blocking = (config: Record<string, unknown>) =>
        config.blocking as {
            schedules?: Record<string, unknown>;
            listSchedules?: Record<string, string[]>;
            clientGroupsBlock: Record<string, string[]>;
        };

    it("gates the list and leaves the groups as they are", () => {
        const config = blocking(render.blockyConfig(settings(), SUMMER));
        expect(config.listSchedules).toEqual({ social: ["polaris-1-1"] });
        expect(config.schedules).toEqual({
            "polaris-1-1": { weekdays: ["mon"], start: "19:00", end: "05:00" }
        });
        expect(config.clientGroupsBlock.default).toEqual(["ads", "social", "polaris"]);
    });

    it("never schedules the operator's own group, which holds the check name", () => {
        const config = blocking(
            render.blockyConfig(settings({ schedules: [schedule({ lists: ["polaris"] })] }), SUMMER)
        );
        expect(config.listSchedules).toBeUndefined();
        expect(config.schedules).toBeUndefined();
    });

    it("writes nothing for a category with no list on", () => {
        const config = blocking(render.blockyConfig(settings({ sources: ["hagezi-pro"] }), SUMMER));
        expect(config.schedules).toBeUndefined();
    });

    it("renders differently after a clock change, which is what offers applying again", () => {
        expect(render.encodeBlockyConfig(settings(), SUMMER)).not.toBe(
            render.encodeBlockyConfig(settings(), WINTER)
        );
        const plain = settings({ schedules: [] });
        expect(render.encodeBlockyConfig(plain, SUMMER)).toBe(
            render.encodeBlockyConfig(plain, WINTER)
        );
    });
});

describe("schedule settings", () => {
    const parse = (value: unknown) => dns.dnsScheduleSchema.safeParse(value);
    const issue = (value: unknown) => {
        const parsed = parse(value);
        return parsed.success ? null : parsed.error.issues[0]?.message;
    };

    it("orders and dedupes days and lists", () => {
        const parsed = parse(schedule({ days: ["sun", "mon", "sun"], lists: ["ads", "ads"] }));
        expect(parsed.success && parsed.data).toMatchObject({
            days: ["mon", "sun"],
            lists: ["ads"]
        });
    });

    it("refuses hours the engine would not read", () => {
        expect(issue(schedule({ start: "21:00", end: "" }))).toBe("timePair");
        expect(issue(schedule({ start: "09:00", end: "09:00" }))).toBe("sameTime");
        expect(issue(schedule({ start: "25:00" }))).toBe("invalidTime");
        expect(issue(schedule({ start: "9:00" }))).toBe("invalidTime");
        expect(issue(schedule({ days: [] }))).toBe("noDays");
        expect(issue(schedule({ lists: ["default"] }))).toBe("invalidList");
        expect(parse(schedule({ start: "", end: "" })).success).toBe(true);
    });

    it("reads an older row with no schedules, and an unknown zone as none", () => {
        expect(dns.readDnsSettings({})).toMatchObject({ schedules: [], timeZone: "" });
        expect(dns.readDnsSettings({ timeZone: "Mars/Olympus" }).timeZone).toBe("");
        expect(dns.readDnsSettings({ timeZone: "Europe/Madrid" }).timeZone).toBe("Europe/Madrid");
    });

    it("offers only categories that have a list on", () => {
        expect(
            dns.dnsListedCategories({
                sources: ["hagezi-social", "hagezi-pro"],
                customLists: [{ url: "https://example.com/x.txt", category: "gambling" }]
            })
        ).toEqual(["ads", "gambling", "social"]);
    });
});
