/**
 * The schedule trigger in words: one sentence per kind, in both languages, and
 * the problem the editor shows, read from the schema the server stores it with.
 */

import { describe, expect, it } from "vitest";
import { translatorFor } from "@/lib/i18n/translate";
import * as words from "@/app/(app)/automations/[id]/schedule-words";
import type { T } from "@/app/(app)/automations/[id]/node-fields";

const en = translatorFor("en-US", "automations") as unknown as T;
const es = translatorFor("es-ES", "automations") as unknown as T;

describe("a schedule in one sentence", () => {
    it("says each kind in plain words", () => {
        expect(words.scheduleSummary(en, { kind: "every", amount: 1, unit: "hours" })).toBe(
            "Every hour"
        );
        expect(words.scheduleSummary(en, { kind: "every", amount: 15, unit: "minutes" })).toBe(
            "Every 15 minutes"
        );
        expect(words.scheduleSummary(en, { kind: "daily", times: ["08:00"], days: [] })).toBe(
            "Every day at 08:00"
        );
        expect(
            words.scheduleSummary(en, { kind: "daily", times: ["18:30", "08:00"], days: [5, 1] })
        ).toBe("Every Monday and Friday at 08:00 and 18:30");
        expect(
            words.scheduleSummary(en, { kind: "monthly", days: [15, 1], times: ["09:00"] })
        ).toBe("Every month on day 1 and 15 at 09:00");
        expect(
            words.scheduleSummary(en, { kind: "monthly", days: [1, "last"], times: ["09:00"] })
        ).toBe("Every month on day 1 and the last day at 09:00");
        expect(words.scheduleSummary(en, { kind: "monthly", days: ["last"], times: ["09:00"] })).toBe(
            "On the last day of every month at 09:00"
        );
        expect(
            words.scheduleSummary(en, {
                kind: "yearly",
                dates: [
                    { month: 12, day: 25 },
                    { month: 3, day: 5 }
                ],
                times: ["08:00"]
            })
        ).toBe("Every year on March 5 and December 25 at 08:00");
        expect(words.scheduleSummary(en, { kind: "once", at: "2026-12-01T09:30" })).toBe(
            "Once, on December 1, 2026 at 09:30"
        );
        expect(words.scheduleSummary(en, { kind: "cron", expression: "0 8 * * 1-5" })).toBe(
            "Cron schedule 0 8 * * 1-5"
        );
    });

    it("orders weekdays from the reader's first day of the week", () => {
        const sundays = { kind: "daily", times: ["08:00"], days: [0, 1] };
        expect(words.scheduleSummary(en, sundays, 1)).toBe("Every Monday and Sunday at 08:00");
        expect(words.scheduleSummary(en, sundays, 0)).toBe("Every Sunday and Monday at 08:00");
    });

    it("speaks Spanish", () => {
        expect(
            words.scheduleSummary(es, { kind: "daily", times: ["08:00"], days: [1, 3, 5] })
        ).toBe("Cada lunes, miércoles y viernes a las 08:00");
        expect(
            words.scheduleSummary(es, {
                kind: "yearly",
                dates: [{ month: 2, day: 29 }],
                times: ["08:00"]
            })
        ).toBe("Cada año el 29 de febrero a las 08:00");
    });

    it("says nothing for settings that are not complete", () => {
        expect(words.scheduleSummary(en, { kind: "monthly", days: [], times: ["08:00"] })).toBeNull();
        expect(words.scheduleSummary(en, null)).toBeNull();
    });
});

describe("what is wrong with a schedule", () => {
    it("names the problem from the stored schema", () => {
        expect(words.scheduleProblem({ kind: "daily", times: ["08:00"], days: [] })).toBeNull();
        expect(words.scheduleProblem({ kind: "daily", times: [], days: [] })).toBe("timesRequired");
        expect(words.scheduleProblem({ kind: "daily", times: ["8"], days: [] })).toBe("clockTime");
        expect(words.scheduleProblem({ kind: "monthly", days: [], times: ["08:00"] })).toBe(
            "daysRequired"
        );
        expect(
            words.scheduleProblem({ kind: "yearly", dates: [{ month: 2, day: 30 }], times: ["08:00"] })
        ).toBe("dateInvalid");
        expect(words.scheduleProblem({ kind: "yearly", dates: [], times: ["08:00"] })).toBe(
            "datesRequired"
        );
        expect(words.scheduleProblem({ kind: "once", at: "" })).toBe("dateTimeInvalid");
        expect(words.scheduleProblem({ kind: "cron", expression: "nope" })).toBe("cronInvalid");
        expect(words.scheduleProblem({ kind: "every", amount: Number.NaN, unit: "minutes" })).toBe(
            "amountInvalid"
        );
    });

    it("has words for every problem in both languages", () => {
        const problems: words.ScheduleProblem[] = [
            "clockTime",
            "cronInvalid",
            "daysRequired",
            "datesRequired",
            "dateInvalid",
            "dateTimeInvalid",
            "timesRequired",
            "amountInvalid",
            "invalid"
        ];
        for (const problem of problems)
            for (const t of [en, es]) expect(t(`schedule.errors.${problem}`)).not.toContain("schedule.");
    });
});
