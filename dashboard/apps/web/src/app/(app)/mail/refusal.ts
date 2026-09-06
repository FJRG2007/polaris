/**
 * The sentence a server action came back with, or nothing.
 *
 * Every action in this app answers with either what it did or a sentence saying
 * why it did not, which makes the two shapes a union at every call site. Read
 * once here rather than narrowed by hand in twenty components, so a screen can
 * never show a refusal it did not check for or swallow one it did.
 */
export function refusalOf(outcome: unknown): string {
    if (typeof outcome !== "object" || outcome === null || !("error" in outcome)) return "";
    const said = (outcome as { error?: unknown }).error;
    return typeof said === "string" ? said : "";
}

/**
 * The one refusal a screen answers with a question rather than a sentence.
 *
 * An action that needs a folder this mailbox has none of comes back naming the
 * role and the mailbox, so the screen can ask which folder it is instead of
 * telling somebody their archive failed.
 */
export function missingFolderRole(outcome: unknown): { role: string; accountId: string } | null {
    if (typeof outcome !== "object" || outcome === null || !("needsFolderRole" in outcome)) return null;
    const held = (outcome as { needsFolderRole?: unknown }).needsFolderRole;
    if (typeof held !== "object" || held === null) return null;
    const { role, accountId } = held as { role?: unknown; accountId?: unknown };
    return typeof role === "string" && typeof accountId === "string" ? { role, accountId } : null;
}
