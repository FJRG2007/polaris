/**
 * The selection as a spreadsheet.
 *
 * Built in the browser from the rows already on screen, so it says exactly what
 * the reader was looking at and costs no round trip. The headings are the
 * reader's own words, passed in, so the file opens in their language.
 */

import type { TaskRow } from "@/lib/tasks/facts";

export interface CsvHeadings {
    readonly reference: string;
    readonly task: string;
    readonly list: string;
    readonly status: string;
    readonly priority: string;
    readonly assignees: string;
    readonly due: string;
}

/**
 * One cell, made safe to open.
 *
 * A spreadsheet runs a cell that starts with `=`, `+`, `-`, `@` (or a tab or a
 * carriage return in front of one) as a formula, so a task named
 * `=HYPERLINK(...)` would be a link somebody clicks in Excel believing it is
 * data. Those are written with a leading apostrophe, which every spreadsheet
 * reads as "this is text". Then the usual quoting: a comma, a quote or a line
 * break puts the cell in quotes, with its quotes doubled.
 */
export function csvCell(value: string): string {
    const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function tasksToCsv(
    tasks: readonly TaskRow[],
    headings: CsvHeadings,
    priorityLabel: (priority: TaskRow["priority"]) => string
): string {
    const lines = [
        [
            headings.reference,
            headings.task,
            headings.list,
            headings.status,
            headings.priority,
            headings.assignees,
            headings.due
        ],
        ...tasks.map((task) => [
            task.reference,
            task.name,
            task.listName,
            task.statusName,
            priorityLabel(task.priority),
            task.assignees.map((person) => person.name).join("; "),
            task.dueDate ?? ""
        ])
    ];
    // CRLF, which is what RFC 4180 and every spreadsheet expect.
    return lines.map((cells) => cells.map(csvCell).join(",")).join("\r\n");
}

/**
 * Hand the file to the browser.
 *
 * A byte-order mark goes first: without it Excel reads the file as the
 * machine's legacy code page, and every accented name in a Spanish team's
 * board comes out as mojibake.
 */
export function downloadCsv(fileName: string, csv: string): void {
    const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    // Revoked on the next tick, once the click has handed the URL over.
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
