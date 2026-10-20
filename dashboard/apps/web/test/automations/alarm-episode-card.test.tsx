/**
 * The alarm a threshold run was started for, as the run page shows it: the
 * line crossed in words, when and from what value, the worst value, and either
 * when it came back and how long it lasted or that it is still going on.
 */

import { withMessages } from "../setup/i18n";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { EpisodeView } from "@/lib/automations/alarm-episodes";

vi.mock("@/app/(app)/automations/actions", () => ({ thresholdChoicesAction: async () => ({ ok: true, kinds: [] }) }));

const { AlarmEpisodeCard } = await import("@/app/(app)/automations/runs/[runId]/alarm-episode");

const resolved: EpisodeView = {
    id: "0192f6a0-0000-7000-8000-0000000000e1",
    nodeId: "t1",
    source: "ups.charge",
    comparator: "lt",
    threshold: 30,
    startedAt: "2030-01-01T10:00:00.000Z",
    startValue: 28,
    peakValue: 12.5,
    resolvedAt: "2030-01-01T10:20:00.000Z",
    endValue: 45,
    durationSeconds: 1200
};

const render = (episode: EpisodeView, locale: "en-US" | "es-ES" = "en-US") =>
    renderToStaticMarkup(withMessages(<AlarmEpisodeCard episode={episode} />, locale));

describe("the alarm episode card", () => {
    it("names the line, the worst value, the way back and how long it lasted", () => {
        const markup = render(resolved);
        expect(markup).toContain("Battery charge &lt; 30");
        expect(markup).toContain("Recovered");
        expect(markup).toContain("12.5");
        expect(markup).toContain("(28)");
        expect(markup).toContain("(45)");
        expect(markup).toContain("20m");
        expect(markup).not.toContain("Still in alarm");
    });

    it("says an alarm still going on has not come back yet", () => {
        const markup = render({ ...resolved, resolvedAt: null, endValue: null, durationSeconds: null });
        expect(markup).toContain("Still in alarm");
        expect(markup).toContain("Not yet");
        expect(markup).toContain("so far");
        expect(markup).not.toContain("Recovered");
    });

    it("reads in Spanish", () => {
        const markup = render(resolved, "es-ES");
        expect(markup).toContain("Carga de batería &lt; 30");
        expect(markup).toContain("Recuperada");
    });

    it("shows a source nothing names yet by its id", () => {
        expect(render({ ...resolved, source: "nas.disk_temp", comparator: "gte" })).toContain(
            "nas.disk_temp &gt;= 30"
        );
    });
});
