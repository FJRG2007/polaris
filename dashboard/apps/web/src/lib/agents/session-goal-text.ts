/**
 * What a Code session's `/goal` judge reads, and what the turn it judges did,
 * from the session's stored conversation (`AgentSessionMessage`, oldest
 * first). Pure, so the shape the judge sees is asserted in a test.
 */

import type { GoalTurnOutcome } from "@/lib/polar/goals";

/** One stored line of the session's conversation, as far as the judge needs it. */
export interface GoalLine {
    readonly role: string;
    readonly kind: string;
    readonly subject: string;
    readonly body: string;
}

/** How much of one line goes into the transcript. */
const LINE_MAX = 1_500;

function clip(text: string): string {
    const flat = text.trim();
    return flat.length > LINE_MAX ? `${flat.slice(0, LINE_MAX)}...` : flat;
}

/** The conversation as the judge reads it: who said what, tools by name. */
export function sessionGoalTranscript(lines: readonly GoalLine[]): string {
    return lines
        .map((line) => {
            if (line.kind === "marker") return line.subject ? `[${line.subject}]` : "";
            const who = line.role === "user" ? "Person" : line.role === "agent" ? "Assistant" : "System";
            if (line.kind === "tool") return `${who} used ${line.subject || "a tool"}: ${clip(line.body)}`;
            if (line.kind === "result") return `Tool result${line.subject ? ` (${line.subject})` : ""}: ${clip(line.body)}`;
            return line.body.trim() ? `${who}: ${clip(line.body)}` : "";
        })
        .filter(Boolean)
        .join("\n");
}

/**
 * What the newest turn did: the lines after the person's last message. A turn
 * cut short leaves an `interrupted` marker; a session waiting on a person
 * (`waiting`) has a question or an approval open and is not judged.
 */
export function sessionTurnOutcome(lines: readonly GoalLine[], waiting: boolean): GoalTurnOutcome {
    let start = lines.length;
    while (start > 0 && lines[start - 1]?.role !== "user") start -= 1;
    const turn = lines.slice(start);
    return {
        awaitingApproval: waiting,
        interrupted: turn.some((line) => line.kind === "marker" && line.subject === "interrupted"),
        usedTools: turn.some((line) => line.kind === "tool"),
        // The session's own usage is accounted by its tool; nothing is spent
        // here but the judge, which is recorded as a helper job.
        tokens: 0
    };
}
