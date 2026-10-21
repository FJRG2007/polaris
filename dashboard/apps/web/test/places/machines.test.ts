import { APP_SECTIONS } from "@/lib/apps";
import { describe, expect, it } from "vitest";
import * as cardOrder from "@/lib/watch/card-order";
import { OVERVIEW_WIDGETS } from "@/lib/overview/catalog";
import { dailyDowntime } from "@/lib/connectivity/outages";
import { inPlaces, machineHref } from "@/lib/machines/machine-links";
import { episodesFrom, mergedSpans } from "@/lib/machines/alarm-episodes";

const HOUR = 3_600_000;
const since = Date.UTC(2026, 9, 1);
const at = (hours: number) => since + hours * HOUR;
const event = (alarmId: string, kind: string, hours: number) => ({ alarmId, alarmName: alarmId, kind, at: at(hours) });

describe("alarm episodes", () => {
    it("pairs a trigger with its resolve and keeps one still firing open", () => {
        const episodes = episodesFrom(
            [event("cpu", "triggered", 1), event("cpu", "resolved", 3), event("cpu", "triggered", 10)],
            since
        );
        expect(episodes).toEqual([
            { alarmId: "cpu", alarmName: "cpu", startedAt: at(10), endedAt: null },
            { alarmId: "cpu", alarmName: "cpu", startedAt: at(1), endedAt: at(3) }
        ]);
    });

    it("starts a resolve with no trigger in the window at the window, and ignores a repeated trigger", () => {
        const episodes = episodesFrom(
            [event("http", "resolved", 2), event("mem", "triggered", 4), event("mem", "triggered", 5), event("mem", "resolved", 6)],
            since
        );
        expect(episodes.map((one) => [one.alarmId, one.startedAt, one.endedAt])).toEqual([
            ["mem", at(4), at(6)],
            ["http", since, at(2)]
        ]);
    });

    it("joins overlapping alarms so a day is not shaded twice", () => {
        const episodes = episodesFrom(
            [event("a", "triggered", 1), event("b", "triggered", 2), event("a", "resolved", 3), event("b", "resolved", 4)],
            since
        );
        const spans = mergedSpans(episodes, at(30));
        expect(spans).toEqual([{ startedAt: at(1), endedAt: at(4), lastSeenAt: at(4) }]);
        const days = dailyDowntime(spans, at(30), 2, 0, "UTC");
        expect(days.reduce((sum, day) => sum + day.downMs, 0)).toBe(3 * HOUR);
    });

    it("keeps an ongoing span open", () => {
        const spans = mergedSpans(episodesFrom([event("a", "triggered", 1)], since), at(5));
        expect(spans).toEqual([{ startedAt: at(1), endedAt: null, lastSeenAt: at(5) }]);
    });
});

describe("machines in Places", () => {
    it("opens a server and a container card in Places, not Watch", () => {
        const base = {
            name: "box",
            detail: "",
            state: "up" as const,
            stateLabel: "up",
            cpuPercent: 1,
            memUsedBytes: 1,
            memTotalBytes: 2,
            spark: [],
            alarms: 0
        };
        expect(inPlaces({ ...base, id: "h1", kind: "server", href: "/watch/server/local" }).href).toBe(
            "/places/machines/server/local"
        );
        expect(inPlaces({ ...base, id: "local:abc", kind: "container", href: "/apps/containers?c=x" }).href).toBe(
            machineHref("container", "local:abc")
        );
        expect(machineHref("container", "local:abc")).toBe("/places/machines/container/local%3Aabc");
    });

    it("is a Places device screen, behind the permission its pages ask", () => {
        const entry = Object.values(APP_SECTIONS)
            .flat()
            .find((section) => section.href === "/places/machines");
        expect(entry?.needs).toBe("deploy.read");
    });

    it("keeps the Overview's usage card and opens it in Places", () => {
        expect(OVERVIEW_WIDGETS.find((widget) => widget.id === "usage")?.href).toBe("/places/machines");
    });
});

describe("remembered card order", () => {
    it("reads what was saved, and busiest first for anything else", () => {
        expect(cardOrder.storedOrder("memory")).toBe("memory");
        expect(cardOrder.storedOrder("name")).toBe("name");
        expect(cardOrder.storedOrder(null)).toBe("cpu");
        expect(cardOrder.storedOrder("price")).toBe("cpu");
    });
});
