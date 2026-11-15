/**
 * A Code session's transcript as a file: Markdown to read, JSONL to process.
 *
 * Built from the thread the reader sees (`polarCodeThread`), so the file holds
 * what the screen holds - the messages and every step the agent took - and
 * nothing the reader could not already open. JSONL is one header line about
 * the session, then one line per entry in order, like the CLI's own
 * transcripts. Pure: the route reads the thread and the words.
 */

import { exportFileName } from "@/lib/polar/export-name";

export const TRANSCRIPT_FORMATS = ["md", "jsonl"] as const;
export type TranscriptFormat = (typeof TRANSCRIPT_FORMATS)[number];

export interface TranscriptEntry {
    readonly at: string;
    readonly type: "message" | "event";
    readonly role: string;
    readonly text: string;
    readonly detail: string;
}

export interface TranscriptSession {
    readonly id: string;
    readonly title: string;
    readonly repo: string;
    readonly branch: string;
    readonly cli: string;
    readonly createdAt: string;
}

/** The reader's words for the parts of the Markdown file. */
export interface TranscriptNames {
    readonly you: string;
    readonly agent: string;
    readonly polaris: string;
    readonly repository: string;
    readonly branch: string;
    readonly started: string;
    readonly steps: string;
}

function speaker(role: string, names: TranscriptNames): string {
    if (role === "user") return names.you;
    if (role === "system") return names.polaris;
    return names.agent;
}

/** The session as Markdown: a header, then each message under its speaker and
 *  each run of steps as a list. */
export function transcriptMarkdown(
    session: TranscriptSession,
    entries: readonly TranscriptEntry[],
    names: TranscriptNames
): string {
    const lines: string[] = [`# ${session.title || session.id}`, ""];
    if (session.repo) lines.push(`- ${names.repository}: ${session.repo}`);
    if (session.branch) lines.push(`- ${names.branch}: ${session.branch}`);
    lines.push(`- ${names.started}: ${session.createdAt}`, "");
    let inSteps = false;
    for (const entry of entries) {
        if (entry.type === "event") {
            if (!inSteps) lines.push(`**${names.steps}**`, "");
            inSteps = true;
            const detail = entry.detail ? `: ${entry.detail.replace(/\s+/g, " ")}` : "";
            lines.push(`- ${entry.text}${detail}`);
            continue;
        }
        if (inSteps) lines.push("");
        inSteps = false;
        lines.push(`## ${speaker(entry.role, names)} - ${entry.at}`, "", entry.text, "");
    }
    return `${lines.join("\n").trimEnd()}\n`;
}

/** The session as JSONL: a header line, then one line per entry. */
export function transcriptJsonl(session: TranscriptSession, entries: readonly TranscriptEntry[]): string {
    const header = JSON.stringify({ type: "session", version: 1, ...session });
    const rows = entries.map((entry) => JSON.stringify(entry));
    return `${[header, ...rows].join("\n")}\n`;
}

/** The file's name and media type for a format. */
export function transcriptFile(
    session: TranscriptSession,
    format: TranscriptFormat
): { name: string; type: string } {
    return format === "md"
        ? { name: exportFileName(session.title, session.id, "md"), type: "text/markdown; charset=utf-8" }
        : { name: exportFileName(session.title, session.id, "jsonl"), type: "application/x-ndjson; charset=utf-8" };
}
