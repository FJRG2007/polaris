/**
 * Lining competitors up against the things that actually matter.
 *
 * Asked where this belongs - a spreadsheet or a diagram - and the answer is
 * neither, for a reason worth writing down because it is the whole design:
 *
 * **A comparison is structured data, and a chart is one view of it.** Competitors
 * go down, criteria go across, and a cell is not a number - it is a small record.
 * A rating, the evidence for it, where that evidence came from, and when
 * somebody last checked. In a spreadsheet every one of those four is a
 * convention somebody has to remember; nothing can be validated, the source ends
 * up in a comment or nowhere, and the "last checked" column is empty six months
 * later, which is exactly when it matters. As a drawing it cannot be sorted,
 * filtered, or asked what changed since March.
 *
 * So it is stored like this and drawn afterwards - as a matrix, as a quadrant in
 * Diagrams, or exported to a spreadsheet for whoever wants to take it away. The
 * same decision Tasks already made: store the record, draw the board.
 *
 * What that buys, and a spreadsheet cannot: every claim carries its evidence and
 * its date, so a battlecard can say how old it is instead of quietly being
 * wrong.
 */

import { z } from "zod";

/**
 * What kind of answer a criterion takes.
 *
 * Deliberately few. Every one of these is something a reader can scan down a
 * column and compare at a glance, which is the only reason to have a type at
 * all - a criterion whose answers are five different shapes is a criterion
 * nobody can read across.
 */
export const CRITERION_KINDS = ["rating", "yesNo", "text", "money", "number"] as const;

export type CriterionKind = (typeof CRITERION_KINDS)[number];

export const CRITERION_KIND_LABELS: Record<CriterionKind, string> = {
    rating: "Rating",
    yesNo: "Yes or no",
    text: "Words",
    money: "Price",
    number: "Number"
};

export const CRITERION_KIND_HINTS: Record<CriterionKind, string> = {
    rating: "Better or worse, on a scale everybody in the table shares.",
    yesNo: "They have it, they do not, or it is partial.",
    text: "A sentence, where the answer is not a score.",
    money: "What it costs, in whatever currency the table is in.",
    number: "A count - seats, regions, days."
};

/** The scale a rating uses. Five points, because three cannot express "slightly
 *  better" and ten is a number nobody can apply consistently twice. */
export const RATING_SCALE = [1, 2, 3, 4, 5] as const;

export const RATING_LABELS: Record<number, string> = {
    1: "Far behind",
    2: "Behind",
    3: "Level",
    4: "Ahead",
    5: "Far ahead"
};

/** What a yes-or-no criterion may answer. `partial` earns its place: half the
 *  interesting answers in a competitive table are "sort of", and forcing them to
 *  yes or no is how a table starts lying. */
export const YES_NO_ANSWERS = ["yes", "partial", "no", "unknown"] as const;

export type YesNoAnswer = (typeof YES_NO_ANSWERS)[number];

export const YES_NO_LABELS: Record<YesNoAnswer, string> = {
    yes: "Yes",
    partial: "Partly",
    no: "No",
    unknown: "Not known"
};

/** One thing being compared: a competitor, a vendor, an option. `us` marks the
 *  column that is this company's own, which every comparison has and which the
 *  table draws differently - the point of the exercise is the gap. */
export interface Subject {
    readonly id: string;
    readonly name: string;
    /** Their site, so a claim can be checked. */
    readonly url: string;
    readonly us: boolean;
}

/** One thing they are being compared on. */
export interface Criterion {
    readonly id: string;
    readonly name: string;
    readonly kind: CriterionKind;
    /** What it is for, when the name is not enough - "Support" means different
     *  things to different readers. */
    readonly note: string;
    /**
     * How much this one counts, 0 to 5.
     *
     * Not a score to be multiplied out into a total: a single number that ranks
     * competitors is a number people argue about instead of reading the table.
     * It orders the rows, so what matters most is at the top.
     */
    readonly weight: number;
}

/**
 * What one competitor is, on one criterion.
 *
 * The four fields are the whole point. `value` is the claim, `evidence` is why
 * anybody believes it, `source` is where to check, and `checkedAt` is how old it
 * is. A comparison without the last two is a rumour in a table.
 */
export interface Cell {
    readonly value: string;
    readonly evidence: string;
    readonly source: string;
    /** ISO, or "" when nobody has said. */
    readonly checkedAt: string;
    /** Who last checked, by account id. Resolved to a name when it is drawn. */
    readonly checkedBy: string;
}

export const EMPTY_CELL: Cell = { value: "", evidence: "", source: "", checkedAt: "", checkedBy: "" };

/** The key a cell is stored under. One function, because the editor and every
 *  exporter have to agree and a mismatched separator is a table that silently
 *  loses a column. */
export function cellKey(subjectId: string, criterionId: string): string {
    return `${subjectId}::${criterionId}`;
}

/**
 * How stale a claim is allowed to be before the table says so.
 *
 * Ninety days, which is roughly a quarter: long enough that an active table is
 * not permanently shouting, short enough that a claim about a competitor's
 * pricing cannot quietly be a year old.
 */
export const STALE_AFTER_DAYS = 90;

/** Whether a claim is old enough to be worth re-checking. Never true of one
 *  nobody has checked at all - that is "unchecked", which the table says
 *  differently. */
export function isStale(checkedAt: string, now: Date = new Date()): boolean {
    if (!checkedAt) return false;
    const at = new Date(checkedAt);
    if (Number.isNaN(at.getTime())) return false;
    return now.getTime() - at.getTime() > STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
}

/** How a cell reads when it is drawn, whichever kind its criterion is. */
export function cellReads(cell: Cell, kind: CriterionKind): string {
    if (!cell.value) return "";
    if (kind === "rating") {
        const score = Number(cell.value);
        return RATING_LABELS[score] ?? cell.value;
    }
    if (kind === "yesNo") {
        return YES_NO_LABELS[cell.value as YesNoAnswer] ?? cell.value;
    }
    return cell.value;
}

/**
 * Where each competitor sits, for the quadrant.
 *
 * Two criteria chosen by the reader become the two axes, and everything else is
 * ignored - which is the honest way to draw a positioning chart. A quadrant that
 * silently averaged twelve criteria into two numbers would be a picture of an
 * arithmetic nobody agreed to.
 *
 * Only ratings and numbers can be an axis; a sentence has no position. Anything
 * a subject has not answered is left out rather than plotted at zero, because
 * "not known" at the origin reads as "worst", and that is a claim nobody made.
 */
export function quadrantPoints(
    subjects: readonly Subject[],
    cells: ReadonlyMap<string, Cell>,
    across: string,
    up: string
): { subject: Subject; x: number; y: number }[] {
    const points: { subject: Subject; x: number; y: number }[] = [];
    for (const subject of subjects) {
        const x = Number(cells.get(cellKey(subject.id, across))?.value);
        const y = Number(cells.get(cellKey(subject.id, up))?.value);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        points.push({ subject, x, y });
    }
    return points;
}

/** Whether a criterion can be an axis. */
export function isAxisKind(kind: CriterionKind): boolean {
    return kind === "rating" || kind === "number" || kind === "money";
}

/**
 * The table as a grid of strings, for every exporter.
 *
 * One function so the spreadsheet, the CSV and the Markdown all say the same
 * thing: three exporters that each walked the model would be three chances to
 * drop the evidence column.
 */
export function comparisonRows(
    subjects: readonly Subject[],
    criteria: readonly Criterion[],
    cells: ReadonlyMap<string, Cell>
): string[][] {
    const header = ["Criterion", ...subjects.map((subject) => subject.name)];
    const rows = [header];
    for (const criterion of criteria) {
        rows.push([
            criterion.name,
            ...subjects.map((subject) => {
                const cell = cells.get(cellKey(subject.id, criterion.id)) ?? EMPTY_CELL;
                const read = cellReads(cell, criterion.kind);
                // The evidence travels with the claim. A table exported without
                // it is the rumour again.
                return cell.evidence ? `${read} - ${cell.evidence}` : read;
            })
        ]);
    }
    return rows;
}

export const subjectSchema = z.object({
    name: z.string().trim().min(1, "Give them a name").max(80),
    url: z.string().trim().max(300).default(""),
    us: z.boolean().default(false)
});

export const criterionSchema = z.object({
    name: z.string().trim().min(1, "Give it a name").max(80),
    kind: z.enum(CRITERION_KINDS).default("rating"),
    note: z.string().trim().max(300).default(""),
    weight: z.number().int().min(0).max(5).default(3)
});

export const cellSchema = z.object({
    value: z.string().trim().max(400).default(""),
    evidence: z.string().trim().max(1000).default(""),
    source: z.string().trim().max(500).default(""),
    checkedAt: z.string().trim().max(40).default(""),
    checkedBy: z.string().trim().max(64).default("")
});
