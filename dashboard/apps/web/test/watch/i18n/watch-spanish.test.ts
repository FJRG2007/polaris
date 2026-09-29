/**
 * Watch, in Spanish.
 *
 * The alarm evaluator stores what it judged on as an English sentence, and the
 * schema, the services and the breakdown say theirs in English too. The screens
 * say them through the `watch` catalog, so the English catalog is held to those
 * sentences word for word here and a sample is read in Spanish.
 */

import { describe, expect, it } from "vitest";
import { translatorFor } from "@/lib/i18n/translate";
import { describeThreshold, METRIC_LABEL } from "@/lib/watch/alarm-metrics";
import { alarmStateWord, metricWord, thresholdWords, WATCH_SENTENCES, watchText } from "@/lib/watch/words";

const english = translatorFor("en-US", "watch");
const spanish = translatorFor("es-ES", "watch");

describe("the English services write", () => {
    it("gives every known sentence back as it went in", () => {
        for (const sentence of Object.keys(WATCH_SENTENCES)) {
            expect(watchText(english, sentence)).toBe(sentence);
        }
    });

    it("names every metric and threshold as alarm-metrics does", () => {
        for (const [metric, label] of Object.entries(METRIC_LABEL)) {
            expect(metricWord(english, metric)).toBe(label);
        }
        const alarm = { metric: "network_in", targetType: "host", operator: "gt", threshold: 10 };
        expect(thresholdWords(english, alarm)).toBe(
            describeThreshold(alarm.metric, alarm.targetType, alarm.operator, alarm.threshold)
        );
    });

    it("keeps a stored reading and a shaped sentence word for word", () => {
        for (const sentence of [
            "Network in 12.50 MB/s (threshold > 10 MB/s)",
            "CPU 91.2% (threshold > 90%)",
            "A threshold in GB is required for this metric",
            "Mounted at /data",
            "Polaris - Database",
            "root@10.0.0.2 - the machine Polaris runs on",
            "HTTP 502 from the origin"
        ]) {
            expect(watchText(english, sentence)).toBe(sentence);
        }
    });
});

describe("in Spanish", () => {
    it("reads a stored reading and what the evaluator saw", () => {
        expect(watchText(spanish, "Disk 93.0% (threshold > 90%)")).toBe("Disco 93.0% (umbral > 90%)");
        expect(watchText(spanish, "no recent metrics (down?)")).toBe("sin métricas recientes (¿caída?)");
        expect(watchText(spanish, "Belongs to shop")).toBe("Pertenece a shop");
    });

    it("names states and metrics, and leaves what it does not know alone", () => {
        expect(alarmStateWord(spanish, "insufficient")).toBe("Sin datos");
        expect(metricWord(spanish, "network_out")).toBe("Red saliente");
        expect(metricWord(spanish, "gpu")).toBe("gpu");
        expect(watchText(spanish, "Up 3 hours")).toBe("Up 3 hours");
    });
});
