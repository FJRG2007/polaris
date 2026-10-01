// @vitest-environment jsdom

/**
 * The repeat editor, driven the way a person drives it, round-trips through the
 * engine: what the controls show is the rule that was loaded, and what a change
 * makes is exactly the RRULE the server will store.
 */

import { useState } from "react";
import "@/components/app-host/client";
import { afterEach, describe, expect, it } from "vitest";
import * as engine from "@polaris-app/calendar/src/engine";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RecurrenceEditor } from "@polaris-app/calendar/src/screens/recurrence-editor";

const START: engine.DateValue = { dateTime: "2026-10-05T10:00:00", tzid: "Europe/Madrid" };

let latest: engine.RuleEditorModel | null = null;

function Harness({ raw, start = START }: { raw: string | null; start?: engine.DateValue }) {
    const rule = raw ? engine.parseRule(raw) : null;
    const [model, setModel] = useState(() => engine.editorFromRule(rule, start));
    latest = model;
    return (
        <RecurrenceEditor
            value={model}
            onChange={(next) => {
                latest = next;
                setModel(next);
            }}
            start={start}
            rule={rule}
        />
    );
}

function savedRule(start: engine.DateValue = START): string | null {
    const rule = latest ? engine.ruleFromEditor(latest, start) : null;
    return rule ? engine.formatRule(rule) : null;
}

afterEach(() => {
    cleanup();
    latest = null;
});

describe("the repeat editor", () => {
    it("shows a weekly rule as it was stored and saves the weekday that is added", async () => {
        render(<Harness raw="FREQ=WEEKLY;BYDAY=MO,WE" />);
        const monday = screen.getByRole("button", { name: "Monday" });
        const friday = screen.getByRole("button", { name: "Friday" });
        expect(monday.getAttribute("aria-pressed")).toBe("true");
        expect(screen.getByRole("button", { name: "Wednesday" }).getAttribute("aria-pressed")).toBe(
            "true"
        );
        expect(friday.getAttribute("aria-pressed")).toBe("false");
        expect(savedRule()).toBe("FREQ=WEEKLY;BYDAY=MO,WE");

        fireEvent.click(friday);
        expect(savedRule()).toBe("FREQ=WEEKLY;BYDAY=MO,WE,FR");
        expect(await screen.findByText("Weekly on Monday, Wednesday, and Friday")).toBeDefined();
    });

    it("writes the interval into the rule", () => {
        render(<Harness raw="FREQ=WEEKLY;BYDAY=MO" />);
        fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "2" } });
        expect(savedRule()).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO");
    });

    it("keeps a monthly 'last Friday' rule and its end after a count", () => {
        render(<Harness raw="FREQ=MONTHLY;BYDAY=-1FR;COUNT=6" />);
        expect(latest?.monthlyMode).toBe("ordinal");
        expect(latest?.ordinal).toBe(-1);
        expect(latest?.ordinalDay).toBe("FR");
        expect(savedRule()).toBe("FREQ=MONTHLY;BYDAY=-1FR;COUNT=6");
        fireEvent.change(screen.getByRole("spinbutton", { name: "Times" }), {
            target: { value: "8" }
        });
        expect(savedRule()).toBe("FREQ=MONTHLY;BYDAY=-1FR;COUNT=8");
    });

    it("picks days of the month", () => {
        render(<Harness raw="FREQ=MONTHLY;BYMONTHDAY=5" />);
        fireEvent.click(screen.getByRole("button", { name: "20" }));
        expect(savedRule()).toBe("FREQ=MONTHLY;BYMONTHDAY=5,20");
    });

    it("draws a rule it cannot edit read-only, until it is replaced", () => {
        render(<Harness raw="FREQ=DAILY;BYHOUR=9,17" />);
        expect(screen.getByText(/has parts the editor cannot show/)).toBeDefined();
        expect(screen.queryByRole("group", { name: "Repeat" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Replace rule" }));
        expect(screen.getByRole("group", { name: "Repeat" })).toBeDefined();
    });

    it("starts from the start's own weekday when there is no rule", () => {
        render(<Harness raw={null} />);
        expect(latest?.frequency).toBe("NONE");
        expect(savedRule()).toBeNull();
        // 2026-10-05 is a Monday: switching to weekly already has it ticked.
        expect(latest?.weekdays).toEqual(["MO"]);
    });
});
