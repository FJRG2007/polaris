/**
 * What an office document is, before anything can open one.
 *
 * Five kinds behind one noun. A document, a spreadsheet, a deck, a diagram and a
 * comparison are edited by five different surfaces and are otherwise the same
 * thing: something somebody made, that lives somewhere, that other people are
 * given, that is exported. Everything that is the same is here and is written
 * once; the differences are a table below rather than five modules that drifted.
 *
 * **Why a comparison is one of them.** Asked where competitor comparison
 * belongs, the answer is neither a spreadsheet nor a drawing. It is structured
 * data - competitors down, criteria across, and each cell a small record: a
 * rating, the evidence for it, where that came from, and when it was last
 * checked. In a spreadsheet every one of those is a convention somebody has to
 * remember, nothing can be validated, and the "last checked" column is empty six
 * months later, which is exactly when it matters. In a drawing it cannot be
 * sorted, filtered, or asked what changed since March. So it is stored
 * structured and drawn afterwards - as a matrix, as a quadrant in Diagrams, or
 * exported to a spreadsheet for whoever wants to take it away. The same decision
 * Tasks already made: store the record, draw the board.
 *
 * Pure, so the browser and the server agree on what a kind is and a row that has
 * rotted reads as nothing rather than as something wider.
 */

import { z } from "zod";

/**
 * The kinds, in the order a "new document" menu offers them.
 *
 * `doc` first because it is what most people came for, and `comparison` last
 * because it is the one that needs explaining.
 */
export const OFFICE_KINDS = ["doc", "sheet", "slides", "diagram", "comparison"] as const;

export type OfficeKind = (typeof OFFICE_KINDS)[number];

export function isOfficeKind(value: unknown): value is OfficeKind {
    return (OFFICE_KINDS as readonly unknown[]).includes(value);
}

/** What each kind is called, singular, as a button and a heading say it. */
export const OFFICE_KIND_LABELS: Record<OfficeKind, string> = {
    doc: "Document",
    sheet: "Spreadsheet",
    slides: "Presentation",
    diagram: "Diagram",
    comparison: "Comparison"
};

/** One line saying what it is for, for the menu that offers all five. Written
 *  for somebody deciding, not for somebody who already knows. */
export const OFFICE_KIND_HINTS: Record<OfficeKind, string> = {
    doc: "Write something and lay it out.",
    sheet: "Numbers, formulas and tables.",
    slides: "Something to present.",
    diagram: "Draw how it fits together.",
    comparison: "Line competitors up against the things that matter, with the evidence."
};

/** The name a new one gets. Never blank: an untitled row in a list is a row
 *  nobody can point at. */
export const OFFICE_KIND_UNTITLED: Record<OfficeKind, string> = {
    doc: "Untitled document",
    sheet: "Untitled spreadsheet",
    slides: "Untitled presentation",
    diagram: "Untitled diagram",
    comparison: "Untitled comparison"
};

/** Where one is opened. One route per kind rather than one route that branches,
 *  so a link says what it opens before it is followed. */
export const OFFICE_KIND_PATHS: Record<OfficeKind, string> = {
    doc: "d",
    sheet: "s",
    slides: "p",
    diagram: "g",
    comparison: "c"
};

/** The address of one document inside Polaris. */
export function officeDocumentPath(kind: OfficeKind, id: string): string {
    return `/office/${OFFICE_KIND_PATHS[kind]}/${id}`;
}

/** Read a kind back off a path segment. Anything else is somebody editing an
 *  address, and the answer to that is nothing rather than a guess. */
export function officeKindForPath(segment: string): OfficeKind | null {
    const found = OFFICE_KINDS.find((kind) => OFFICE_KIND_PATHS[kind] === segment);
    return found ?? null;
}

/**
 * What a document can be exported as, per kind.
 *
 * The native format of each kind, plus the neutral ones anybody can open. Every
 * one of these is a real file this Polaris writes - nothing here is declared and
 * unimplemented, because a menu that offers a format and then fails is worse
 * than one that never offered it.
 *
 * **PDF is deliberately not on this list.** Every format here opens in something
 * that prints, and the browser's own print produces a better PDF than a
 * hand-rolled writer ever would - it has the layout engine. So a document offers
 * Print, which is a PDF on every operating system, rather than a worse PDF
 * pretending to be a feature.
 */
export const OFFICE_EXPORTS = {
    doc: ["docx", "md", "html"],
    sheet: ["xlsx", "csv"],
    slides: ["pptx"],
    // Made by the canvas that is already showing the drawing, rather than by
    // redrawing it on a server that would need a browser to do it.
    diagram: ["svg", "png"],
    // The whole point of keeping it structured: it leaves as a spreadsheet
    // anybody can work on, and as the table people paste into a document.
    comparison: ["xlsx", "csv", "md"]
} as const satisfies Record<OfficeKind, readonly string[]>;

export type OfficeExport = (typeof OFFICE_EXPORTS)[OfficeKind][number];

/** What each export is called on the menu. */
export const OFFICE_EXPORT_LABELS: Record<string, string> = {
    docx: "Word (.docx)",
    xlsx: "Excel (.xlsx)",
    pptx: "PowerPoint (.pptx)",
    csv: "Comma-separated (.csv)",
    md: "Markdown (.md)",
    html: "Web page (.html)",
    svg: "Vector image (.svg)",
    png: "Image (.png)"
};

/** Which formats the browser makes rather than the server. A drawing, because
 *  the canvas showing it is already the renderer. */
export function exportedInBrowser(format: string): boolean {
    return format === "svg" || format === "png";
}

/** Whether a kind can be exported that way. The menu is built from this and the
 *  route checks it again, because a menu is not a guard. */
export function canExportAs(kind: OfficeKind, format: string): boolean {
    return (OFFICE_EXPORTS[kind] as readonly string[]).includes(format);
}

/**
 * What somebody may do with a document they did not make.
 *
 * Three rather than two: commenting without editing is the whole of how a draft
 * gets read by the people it is for, and collapsing it into "edit" is what makes
 * everybody either a spectator or a risk.
 */
export const OFFICE_ROLES = ["viewer", "commenter", "editor"] as const;

export type OfficeRole = (typeof OFFICE_ROLES)[number];

export function isOfficeRole(value: unknown): value is OfficeRole {
    return (OFFICE_ROLES as readonly unknown[]).includes(value);
}

export const OFFICE_ROLE_LABELS: Record<OfficeRole, string> = {
    viewer: "Can view",
    commenter: "Can comment",
    editor: "Can edit"
};

export const OFFICE_ROLE_HINTS: Record<OfficeRole, string> = {
    viewer: "Read it and export it. Nothing they do changes it.",
    commenter: "Read it and leave comments, without changing the document itself.",
    editor: "Change it, and share it with other people."
};

/** Whether `held` is `wanted` or stronger. Ordered least to most and compared by
 *  index, the same shape every other ladder in Polaris uses. */
export function officeRoleAtLeast(held: OfficeRole, wanted: OfficeRole): boolean {
    return OFFICE_ROLES.indexOf(held) >= OFFICE_ROLES.indexOf(wanted);
}

/** The stronger of two, for somebody who is reached more than one way. */
export function strongerOfficeRole(left: OfficeRole, right: OfficeRole): OfficeRole {
    return OFFICE_ROLES.indexOf(left) >= OFFICE_ROLES.indexOf(right) ? left : right;
}

/** How long a title may be. Long enough for a real one, short enough that a list
 *  stays a list. */
export const MAX_OFFICE_TITLE = 200;

/** A title, normalized the way every other name in Polaris is: trimmed, and
 *  never empty - a blank title becomes the kind's own. */
export function normalizeOfficeTitle(value: string, kind: OfficeKind): string {
    const trimmed = value.replace(/\s+/g, " ").trim().slice(0, MAX_OFFICE_TITLE);
    return trimmed || OFFICE_KIND_UNTITLED[kind];
}

export const officeCreateSchema = z.object({
    kind: z.enum(OFFICE_KINDS),
    title: z.string().trim().max(MAX_OFFICE_TITLE).default(""),
    /** The organization it belongs to, or nothing for somebody's own. Checked
     *  against what the caller may actually create for. */
    orgId: z.string().trim().max(64).nullable().default(null)
});

export type OfficeCreateInput = z.infer<typeof officeCreateSchema>;

/**
 * A link somebody is about to hand out.
 *
 * The role can be `editor`, because "send them something they can edit" is what
 * people actually ask for - and it is still the weakest thing that works: a link
 * can never share the document on, and never delete it.
 *
 * Every limit is optional and every one of them is worth offering, because the
 * question behind a link is always the same: how much do I trust the place I am
 * about to paste this.
 */
export const officeLinkSchema = z.object({
    role: z.enum(OFFICE_ROLES).default("viewer"),
    /** Empty for a link with no password. */
    password: z.string().max(200).default(""),
    /** An ISO date, or "" for one that does not expire. */
    expiresAt: z.string().trim().max(40).default(""),
    /** How many openings it is worth, or null for unlimited. */
    maxUses: z.coerce.number().int().min(1).max(10_000).nullable().default(null),
    /** Who it was made for, in the maker's own words. Shown only to them. */
    note: z.string().trim().max(200).default("")
});

export type OfficeLinkInput = z.infer<typeof officeLinkSchema>;

/** What somebody typed into the password box on a link. */
export const officeLinkUnlockSchema = z.object({
    password: z.string().min(1, "Type the password").max(200)
});

export const officeRenameSchema = z.object({
    id: z.string().trim().min(1).max(64),
    title: z.string().trim().max(MAX_OFFICE_TITLE)
});

/**
 * How a list is sorted.
 *
 * Recently opened first by default, and by the reader's own opening rather than
 * anybody's editing: a shared document somebody else touched this morning is not
 * more relevant than the one this person was in yesterday.
 */
export const OFFICE_SORTS = ["opened", "edited", "created", "title"] as const;

export type OfficeSort = (typeof OFFICE_SORTS)[number];

export const DEFAULT_OFFICE_SORT: OfficeSort = "opened";

export const OFFICE_SORT_LABELS: Record<OfficeSort, string> = {
    opened: "Last opened by me",
    edited: "Last edited",
    created: "Newest",
    title: "Name"
};

export function readOfficeSort(value: unknown, fallback: OfficeSort = DEFAULT_OFFICE_SORT): OfficeSort {
    return (OFFICE_SORTS as readonly unknown[]).includes(value) ? (value as OfficeSort) : fallback;
}

/** Which of a list is being shown. A kind, or everything. */
export function readOfficeKindFilter(value: unknown): OfficeKind | "" {
    return isOfficeKind(value) ? value : "";
}
