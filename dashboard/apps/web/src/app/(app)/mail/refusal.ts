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
