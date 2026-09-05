/**
 * The sections of a telemetry project, as the rail lists them.
 *
 * Their own module rather than a constant inside the view, for the same reason
 * Deploy's are: they are data and the view is not, and reaching them through it
 * would drag the actions, the session and the database in behind a list of four
 * strings.
 *
 * The shape of this screen used to be a dropdown with everything stacked under
 * it - the address to copy, the rules about who may report, and the list of
 * faults - so the two settings were in front of somebody every time they came to
 * read a stack trace, and the list they came for started halfway down. A project
 * is a thing you go into, so it has an inside.
 */

import { Bug, KeyRound, Settings, ShieldCheck, type LucideIcon } from "lucide-react";

export interface Section {
    /** What it is called in the URL. Short and stable: it ends up in links
     *  people send each other. */
    readonly key: string;
    readonly label: string;
    readonly icon: LucideIcon;
    readonly hint: string;
}

export const SECTIONS: readonly Section[] = [
    { key: "issues", label: "Issues", icon: Bug, hint: "What is failing, and how often" },
    {
        key: "client",
        label: "Client",
        icon: KeyRound,
        hint: "The address to point a reporter at"
    },
    {
        key: "reporters",
        label: "Reporters",
        icon: ShieldCheck,
        hint: "Who is allowed to report into this project"
    },
    { key: "settings", label: "Settings", icon: Settings, hint: "How long events are kept" }
];

/** What a project opens on. The faults, because that is what somebody came for;
 *  everything else here is configured once and read never. */
export const DEFAULT_SECTION = "issues";

/**
 * The section a link is asking for, or the default.
 *
 * Validated rather than trusted: the value comes out of a URL, it is used to
 * choose what to render, and a link with a typo in it should land on the issues
 * rather than on a blank frame with a lit rail entry.
 */
export function sectionFor(value: string | null | undefined): string {
    const wanted = (value ?? "").trim().toLowerCase();
    return SECTIONS.some((section) => section.key === wanted) ? wanted : DEFAULT_SECTION;
}
