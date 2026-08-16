/**
 * A shelf of ARK mods to start from, for a server with nothing installed.
 *
 * The Minecraft screen opens on categories because Modrinth's index is free to
 * search; Steam's is not - browsing the Workshop through the API needs a Web API
 * key, and an instance where nobody has configured one would otherwise open on an
 * empty box and the word "search". That is a screen that tells somebody who has
 * never installed an ARK mod nothing at all.
 *
 * So Polaris carries a short list of the ones a private server actually reaches
 * for, grouped by what they do. Only the choice and the sentence explaining it
 * are Polaris'; every name, size and picture beside them is read from Steam at the
 * moment the screen is drawn, so nothing here can quietly describe a mod that has
 * changed or been taken down - it will say so on the row.
 *
 * Each id was resolved against Steam before it was written down. A Workshop id
 * nobody checked is a mod list that installs silence.
 */

/** What a shelf entry is for, which decides which button the row offers: a mod is
 *  added to the load order, a map replaces the one the server runs. */
export type ArkModKind = "mod" | "map";

export interface ArkModSuggestion {
    readonly id: string;
    /** What Steam called it when this was written, used only as a label while
     *  Steam is unreachable. What is drawn otherwise comes from Steam. */
    readonly name: string;
    /** Why somebody would want it, in one line. */
    readonly why: string;
    readonly kind: ArkModKind;
}

export interface ArkModShelf {
    readonly group: string;
    readonly entries: readonly ArkModSuggestion[];
}

/**
 * The shelves, in the order they are worth reading.
 *
 * Quality of life first: they are small, they change no rules, and they are what
 * every server ends up installing anyway. The heavy ones are last and their size
 * is on the row, because a 3 GB mod is a different decision from a 3 MB one.
 */
export const ARK_MOD_SHELVES: readonly ArkModShelf[] = [
    {
        group: "Quality of life",
        entries: [
            {
                id: "1404697612",
                name: "Awesome SpyGlass!",
                why: "Look at anything and see its level, stats and torpor. The one mod every server ends up with.",
                kind: "mod"
            },
            {
                id: "793605978",
                name: "Super Spyglass (Open Source)",
                why: "The same idea, kept up by the community. Pick one of the two, not both.",
                kind: "mod"
            },
            {
                id: "566885854",
                name: "Death Helper",
                why: "Find where you died and what you were carrying, instead of losing an evening to it.",
                kind: "mod"
            },
            {
                id: "566887000",
                name: "Pet Finder",
                why: "Points at a tame you have left somewhere on the map.",
                kind: "mod"
            },
            {
                id: "889745138",
                name: "Awesome Teleporters!",
                why: "Teleport pads between bases. What most servers use instead of raising flyer speed.",
                kind: "mod"
            }
        ]
    },
    {
        group: "Building",
        entries: [
            {
                id: "731604991",
                name: "Structures Plus (S+)",
                why: "Snap points that work, pick-up without a timer, and pipes and wires that hide. The building mod.",
                kind: "mod"
            },
            {
                id: "821530042",
                name: "Upgrade Station",
                why: "Turn spare gear into better gear, so a bad drop is not simply thrown away.",
                kind: "mod"
            }
        ]
    },
    {
        group: "Creatures",
        entries: [
            {
                id: "895711211",
                name: "Classic Flyers",
                why: "Gives flyers their speed levelling back, the way it worked before it was taken out.",
                kind: "mod"
            },
            {
                id: "1251632107",
                name: "Immersive Taming",
                why: "Tame by feeding and bonding rather than by knocking everything out.",
                kind: "mod"
            },
            {
                id: "632898827",
                name: "Dino Colors Plus",
                why: "Far more colours on wild creatures, and babies for species that had none.",
                kind: "mod"
            }
        ]
    },
    {
        group: "Bigger changes",
        entries: [
            {
                id: "1169020368",
                name: "Ark Creatures Rebalanced (AG Reborn)",
                why: "An overhaul: new creatures, rebalanced stats, its own progression. Several gigabytes, and it changes the game.",
                kind: "mod"
            },
            {
                id: "1523045986",
                name: "Additional Creatures 2: Paranoia!",
                why: "A large set of new creatures, without rewriting the rest of the game.",
                kind: "mod"
            },
            {
                id: "916417001",
                name: "Ebenus Astrum",
                why: "A whole map of its own, with its own biomes. Use it as the map rather than as a mod.",
                kind: "map"
            }
        ]
    }
];

/** Every id on the shelves, for the one call that resolves them all. */
export function shelfModIds(): string[] {
    return ARK_MOD_SHELVES.flatMap((shelf) => shelf.entries.map((entry) => entry.id));
}

/** The suggestion behind an id, for a row that needs its sentence. */
export function findSuggestion(id: string): ArkModSuggestion | undefined {
    return ARK_MOD_SHELVES.flatMap((shelf) => shelf.entries).find((entry) => entry.id === id);
}
