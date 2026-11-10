/**
 * The skills Polar ships with, written for Polaris. Each one is added to a
 * person's own list as a copy they can edit; the description is what the
 * model reads to decide when it applies, so it says when, not what. The
 * screen shows each one's translated title and summary instead
 * (`settings.skills.catalog.<id>`). Client-safe.
 */

import type { SkillInput } from "@/lib/polar/skills/shared";

export interface CatalogSkill extends SkillInput {
    id: string;
}

export const SKILL_CATALOG: readonly CatalogSkill[] = [
    {
        id: "commit-message",
        name: "commit-message",
        description:
            "Use when the person asks for a commit message, or shares a diff or a list of changes they are about to commit.",
        instructions: [
            "# Writing a commit message",
            "",
            "1. Read the whole change first. If only a description was given, ask for the diff when the description is too vague to name what changed.",
            "2. Find the one reason the change exists. A change with two unrelated reasons should be two commits: say so and offer a message for each.",
            "3. Write the subject line: imperative mood (\"Add\", \"Fix\", not \"Added\"), at most 72 characters, no trailing period. If the repository uses a convention such as `type(scope): subject`, follow it.",
            "4. Leave one blank line, then a body wrapped at 72 characters that explains why the change was needed and anything a reviewer would not see from the diff: a trade-off, a migration, a behaviour that changed on purpose.",
            "5. Do not list every file touched, and do not restate the diff line by line.",
            "6. Reference an issue only if the person gave one; never invent a number.",
            "",
            "Answer with the message in a code block, then one line on anything you were unsure about."
        ].join("\n")
    },
    {
        id: "thread-summary",
        name: "thread-summary",
        description:
            "Use when the person asks to summarize, catch up on or get the gist of a long conversation, email thread, chat channel or issue discussion.",
        instructions: [
            "# Summarizing a long thread",
            "",
            "Read everything before writing. Then answer with these sections, leaving out any that would be empty:",
            "",
            "- **In one line**: what the thread is about and where it stands now.",
            "- **Decisions**: what was agreed, and by whom when it is clear.",
            "- **Open questions**: what is still undecided, and who it is waiting on.",
            "- **Next steps**: concrete actions, each with its owner and date if the thread gives one.",
            "",
            "Rules:",
            "- Prefer the latest position when people changed their minds, and say that it changed.",
            "- Quote exact numbers, dates and names; never round or guess them.",
            "- Keep opinions attributed to the person who held them.",
            "- Stay under 200 words unless the person asks for more detail."
        ].join("\n")
    },
    {
        id: "reply-email",
        name: "reply-email",
        description:
            "Use when the person wants to answer an email they received, or asks for help writing a reply to a message.",
        instructions: [
            "# Drafting a reply to an email",
            "",
            "1. List, for yourself, every question and request in the original email. The reply must address each one, even if only to say it will follow later.",
            "2. Match the register of the original: formal stays formal, a first-name note can stay short and warm. Write in the language the original was written in unless the person says otherwise.",
            "3. Open with the answer or the decision, not with pleasantries about having received the email.",
            "4. Keep it short: one idea per paragraph, no more than needed. Use a list only when there are three or more parallel items.",
            "5. If something the reply needs is missing (a date, a price, a yes or no), leave a clearly marked placeholder like [DATE] instead of inventing it, and say which placeholders are left.",
            "6. Close with the next step if there is one.",
            "",
            "Answer with a subject line only if the reply needs a new one, then the body ready to paste."
        ].join("\n")
    },
    {
        id: "pr-review",
        name: "pr-review",
        description:
            "Use when the person asks for a review of a pull request, merge request, diff or patch.",
        instructions: [
            "# Reviewing a pull request",
            "",
            "Read the description and the whole diff before commenting. Then report findings, most serious first, in this order of concern:",
            "",
            "1. **Correctness**: logic errors, unhandled cases (empty, null, very large, concurrent), off-by-one, broken error handling.",
            "2. **Security**: unvalidated input, injection, secrets in code, missing authorization checks, unsafe deserialization.",
            "3. **Data safety**: migrations that are not reversible, writes that can lose data, missing transactions.",
            "4. **Behaviour changes** the description does not mention.",
            "5. **Clarity**: naming, dead code, duplication of something that already exists.",
            "",
            "For each finding give the file and line, what is wrong, why it matters, and a concrete fix. Mark each as blocking or optional.",
            "Do not pad the review: no praise list, no style nits a formatter would fix. If you found nothing blocking, say so plainly.",
            "If the diff is cut off or a file is missing, say what you could not see instead of assuming it is fine."
        ].join("\n")
    },
    {
        id: "trip-plan",
        name: "trip-plan",
        description:
            "Use when the person asks to plan a trip, a holiday, a weekend away or an itinerary for a place.",
        instructions: [
            "# Planning a trip",
            "",
            "Before planning, make sure you know: where, the dates or number of days, who is travelling, the rough budget, and the pace they like. Ask for whichever of these is missing in one short question; do not ask about anything else up front.",
            "",
            "Then answer with:",
            "- A day-by-day plan. Each day has a morning, afternoon and evening, grouped by area so the person is not crossing the city twice.",
            "- Travel time between places when it is more than 30 minutes.",
            "- One rest or free block every day or two for a relaxed pace.",
            "- A short list of what to book in advance.",
            "",
            "Rules:",
            "- Opening hours, prices and timetables change: when you can check them on the web, do; when you cannot, say they should be confirmed.",
            "- Never invent a specific restaurant or hotel you cannot verify; describe the kind of place instead.",
            "- Respect the budget; flag anything that would go over it."
        ].join("\n")
    },
    {
        id: "explain-code",
        name: "explain-code",
        description:
            "Use when the person shares code and asks what it does, how it works, or why it behaves the way it does.",
        instructions: [
            "# Explaining code",
            "",
            "1. Work out the level the person wants. If they did not say, start with a short overview and offer more depth.",
            "2. Start with the purpose: what the code is for, in one or two sentences, before any detail.",
            "3. Walk through it in the order it runs, not the order it is written, naming the important variables and what they hold.",
            "4. Point out anything surprising: side effects, hidden I/O, error paths, performance traps, assumptions about the input.",
            "5. Use a tiny example input and trace what happens to it when that makes the flow clearer.",
            "6. Quote only the lines you are talking about, never the whole file again.",
            "",
            "If part of the code depends on something not shown (an import, a config value), say what you are assuming about it."
        ].join("\n")
    },
    {
        id: "meeting-notes",
        name: "meeting-notes",
        description:
            "Use when the person shares a meeting transcript, recording summary or rough notes and wants them turned into clean notes.",
        instructions: [
            "# Turning a meeting into notes",
            "",
            "Answer with these sections:",
            "",
            "- **Meeting**: title, date and attendees if they are given.",
            "- **Summary**: three to five sentences on what the meeting covered and concluded.",
            "- **Decisions**: one line each.",
            "- **Action items**: a checklist, each item with an owner and a due date when one was said. Write \"owner: unassigned\" rather than guessing.",
            "- **Open questions**: what was raised and not settled.",
            "",
            "Rules:",
            "- Drop small talk, repetition and filler words from the transcript.",
            "- Keep numbers, dates and names exactly as said.",
            "- When the transcript is unclear about who said or agreed to something, say so instead of attributing it."
        ].join("\n")
    },
    {
        id: "bug-report",
        name: "bug-report",
        description:
            "Use when the person describes something broken and wants to report it, or asks to turn a complaint or error into a bug report or issue.",
        instructions: [
            "# Writing a bug report",
            "",
            "Turn what the person described into a report with these parts:",
            "",
            "- **Title**: what is broken and where, in under 80 characters. Not \"it doesn't work\".",
            "- **Steps to reproduce**: numbered, starting from a known state, each step one action.",
            "- **Expected result** and **actual result**, each one sentence.",
            "- **Environment**: version, browser or OS, account type - only what the person gave.",
            "- **Evidence**: error messages quoted exactly, in a code block.",
            "- **Impact**: who is affected and whether there is a workaround.",
            "",
            "If a step, the expected result or the error text is missing, ask for it in one short list of questions before writing the report, or write the report with clearly marked gaps if the person wants it now.",
            "Never invent an error message, version or step."
        ].join("\n")
    }
];

export function catalogSkill(id: string | null | undefined): CatalogSkill | null {
    return SKILL_CATALOG.find((skill) => skill.id === id) ?? null;
}
