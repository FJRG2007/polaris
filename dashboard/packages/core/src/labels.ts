/**
 * Telling two things with the same name apart.
 *
 * Polaris is full of pickers that list things by name: move this task to a list,
 * file this note in a folder, put this service in a project. A name is what
 * somebody recognises, so a name is what a row shows - right up until two of them
 * are called "Tasks", and then the picker is asking a question it has not given
 * the reader enough to answer.
 *
 * The fix is not to qualify everything. A list of "Backlog (Website / Sprint)",
 * "Ideas (Website / Sprint)", "Done (Website / Sprint)" is harder to read than
 * the names alone and says nothing the reader did not know. Only the names that
 * are actually shared need saying where they are, and this decides which those
 * are so every picker can answer it the same way.
 */

/** How two names are compared. Case and surrounding space are not a difference
 *  anybody can see in a menu, so they are not a difference here either. */
function key(label: string): string {
    return label.trim().toLowerCase();
}

/**
 * The names that appear more than once, as they compare.
 *
 * Test membership with `ambiguous.has(key)` where the key comes from
 * `labelKey` - not with the raw label, or "Tasks" and "tasks " will disagree
 * about whether they are the same name.
 */
export function ambiguousLabels(labels: Iterable<string>): ReadonlySet<string> {
    const seen = new Set<string>();
    const twice = new Set<string>();
    for (const label of labels) {
        const value = key(label);
        if (!value) continue;
        if (seen.has(value)) twice.add(value);
        seen.add(value);
    }
    return twice;
}

/** The form `ambiguousLabels` compares by, for looking one up. */
export function labelKey(label: string): string {
    return key(label);
}

/** Whether this row has to say where it is, given the set the list produced. */
export function needsQualifying(label: string, ambiguous: ReadonlySet<string>): boolean {
    return ambiguous.has(key(label));
}
