/**
 * The threshold trigger's form is judged by the schema save and publish use:
 * a field not filled in yet is required, never "not valid"; one filled in
 * wrongly is invalid; and the default a new trigger starts from is incomplete
 * only where the reader still has to choose.
 */

import * as core from "@polaris/core";
import { describe, expect, it } from "vitest";
import * as form from "@/lib/automations/threshold-form";

const SUBJECT = "0192f6a0-0000-7000-8000-0000000000aa";
const filled = {
    source: "host.cpu",
    subjectId: SUBJECT,
    comparator: "gt",
    value: 90,
    streak: 3,
    recovery: false
};

describe("the threshold form", () => {
    it("is all ok for a config the schema accepts", () => {
        expect(core.thresholdConfigSchema.safeParse(filled).success).toBe(true);
        expect(Object.values(form.thresholdFieldStates(filled))).toEqual([
            "ok",
            "ok",
            "ok",
            "ok",
            "ok"
        ]);
    });

    it("marks what a new trigger has not chosen yet as required, not invalid", () => {
        const fresh = { source: "", subjectId: "", comparator: "gt", streak: 3, recovery: false };
        expect(form.thresholdFieldStates(fresh)).toEqual({
            source: "required",
            subjectId: "required",
            comparator: "ok",
            value: "required",
            streak: "ok"
        });
    });

    it("calls a value typed wrongly invalid", () => {
        const states = form.thresholdFieldStates({
            ...filled,
            value: form.numberFromInput("ninety"),
            streak: 0,
            source: "CPU"
        });
        expect(states).toMatchObject({ value: "invalid", streak: "invalid", source: "invalid" });
    });

    it("treats an emptied number box as no value, and a decimal comma as a point", () => {
        expect(form.numberFromInput("")).toBeUndefined();
        expect(form.numberFromInput("  ")).toBeUndefined();
        expect(form.numberFromInput("12,5")).toBe(12.5);
        expect(Number.isNaN(form.numberFromInput("abc"))).toBe(true);
        expect(form.thresholdFieldStates({ ...filled, value: undefined }).value).toBe("required");
        expect(form.thresholdFieldStates({ ...filled, streak: 1.5 }).streak).toBe("invalid");
    });

    it("reads each comparator as a symbol and names each source by a catalog key", () => {
        expect(core.THRESHOLD_COMPARATORS.map(form.comparatorSymbol)).toEqual([
            ">",
            ">=",
            "<",
            "<="
        ]);
        expect(form.sourceKey("ups.input_voltage")).toBe("threshold.sources.ups_input_voltage");
    });
});
