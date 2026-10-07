/**
 * The selection as a spreadsheet: quoted the way RFC 4180 says, and with a
 * cell that a spreadsheet would run as a formula written as text instead - a
 * task named `=HYPERLINK(...)` must open as the words somebody typed, not as a
 * link.
 */

import { describe, expect, it } from "vitest";
import type { TaskRow } from "@/lib/tasks/facts";
import { csvCell, tasksToCsv, type CsvHeadings } from "@/app/(app)/tasks/export-csv";

const HEADINGS: CsvHeadings = {
    reference: "Reference",
    task: "Task",
    list: "List",
    status: "Status",
    priority: "Priority",
    assignees: "Assignees",
    due: "Due"
};

describe("one cell", () => {
    it("is left alone when it needs nothing", () => {
        expect(csvCell("Rotate the logs")).toBe("Rotate the logs");
        expect(csvCell("")).toBe("");
    });

    it("is quoted when it holds a comma, a quote or a line break", () => {
        expect(csvCell("logs, backups")).toBe('"logs, backups"');
        expect(csvCell('the "old" one')).toBe('"the ""old"" one"');
        expect(csvCell("one\ntwo")).toBe('"one\ntwo"');
        expect(csvCell("one\r\ntwo")).toBe('"one\r\ntwo"');
    });

    it.each(["=1+1", "+1", "-1", "@SUM(A1)", "\t=1", "\r=1"])("writes %j as text, not a formula", (value) => {
        expect(csvCell(value).replace(/^"/, "").startsWith("'")).toBe(true);
    });

    it("guards a formula and quotes it when both apply", () => {
        expect(csvCell('=HYPERLINK("http://example.invalid","x")')).toBe(
            `"'=HYPERLINK(""http://example.invalid"",""x"")"`
        );
    });

    it("does not touch a sign in the middle of a cell", () => {
        expect(csvCell("Q3 = done")).toBe("Q3 = done");
    });
});

describe("the file", () => {
    it("has the reader's headings, one line per task, and CRLF between them", () => {
        const task = {
            reference: "FJRG-1",
            name: "Restore, then check",
            listName: "Ops",
            statusName: "Open",
            priority: "urgent",
            assignees: [
                { id: "u1", name: "Ana Ruiz" },
                { id: "u2", name: "Luis Gil" }
            ],
            dueDate: "2026-02-01"
        } as unknown as TaskRow;
        const blank = { ...task, reference: "FJRG-2", name: "=cmd", assignees: [], dueDate: null } as TaskRow;

        const csv = tasksToCsv([task, blank], HEADINGS, (priority) => `P:${priority}`);

        expect(csv.split("\r\n")).toEqual([
            "Reference,Task,List,Status,Priority,Assignees,Due",
            'FJRG-1,"Restore, then check",Ops,Open,P:urgent,Ana Ruiz; Luis Gil,2026-02-01',
            "FJRG-2,'=cmd,Ops,Open,P:urgent,,"
        ]);
    });
});
