/**
 * A name for a session, worked out from its id.
 *
 * A list of sessions is a list of near-identical rows: three of them say "Chrome
 * on Windows" and differ only in an address and a timestamp. Talking about one -
 * to a colleague, in a support message, or to yourself while deciding which to
 * end - means describing it rather than naming it, and describing it is exactly
 * what does not distinguish it.
 *
 * The name is derived, never stored. It falls out of the session id, so it costs
 * no column, survives a database that has never heard of it, and is the same
 * name on every screen that shows the same session without those screens having
 * to agree on anything.
 *
 * Two sessions can land on the same name - 64 names over the handful a person
 * holds collide more often than the number suggests. That is why this is a
 * handle and not an identifier: it sits beside the browser, the operating system
 * and the address, which is what actually tells two rows apart, and nothing is
 * ever looked up by it.
 */

/**
 * Names chosen to be read aloud and typed from memory: one word, unmistakable
 * over a phone line, and none of them a word that also means something in the
 * interface around them.
 */
export const SESSION_NAMES: readonly string[] = [
    "Pegasus", "Celeste", "Onyx", "Ember", "Nova", "Lunar", "Zephyr", "Orbit",
    "Atlas", "Solstice", "Echo", "Storm", "Quartz", "Sable", "Raven", "Diamond",
    "Emberly", "Aster", "Drift", "Neon", "Glimmer", "Phantom", "Hollow", "Twilight",
    "Vortex", "Frost", "Eclipse", "Midnight", "Arbor", "Willow", "Ivy", "Tempest",
    "Shadow", "Mocha", "Cobalt", "Serenity", "Glacier", "Radiant", "Flare", "Dusk",
    "Mist", "Obsidian", "Petrichor", "Cinder", "Breeze", "Echoes", "Solara", "Comet",
    "Wisp", "Aether", "Gale", "Sage", "Emberfox", "Nightfall", "Cascade", "Crimson",
    "Specter", "Opal", "Silhouette", "Mirage", "Flint", "Skyfall", "Ashwood", "Zodiac"
];

/**
 * FNV-1a, 32-bit.
 *
 * Not a security primitive and never used as one: this picks a word out of a
 * list, so what it has to be is cheap, dependency-free and identical everywhere
 * it runs. `Math.imul` is what keeps the multiply 32-bit - a plain `*` loses the
 * low bits to the double's mantissa and the two halves of the app would then
 * disagree about what a session is called.
 */
function fnv1a(input: string): number {
    let hash = 0x811c9dc5;
    for (let index = 0; index < input.length; index++) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

/** The name this session goes by. Empty in, empty out - a caller with no id has
 *  nothing to name, and inventing one would name every such row the same. */
export function sessionName(sessionId: string): string {
    if (!sessionId) return "";
    return SESSION_NAMES[fnv1a(sessionId) % SESSION_NAMES.length] ?? "";
}
