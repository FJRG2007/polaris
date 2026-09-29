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
import { gameMessage } from "../game-message";

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
        group: gameMessage("games", "lib.modShelves.qualityOfLife"),
        entries: [
            {
                id: "1404697612",
                name: "Awesome SpyGlass!",
                why: gameMessage("games", "lib.modWhy.stats"),
                kind: "mod"
            },
            {
                id: "793605978",
                name: "Super Spyglass (Open Source)",
                why: gameMessage("games", "lib.modWhy.community"),
                kind: "mod"
            },
            {
                id: "566885854",
                name: "Death Helper",
                why: gameMessage("games", "lib.modWhy.death"),
                kind: "mod"
            },
            {
                id: "566887000",
                name: "Pet Finder",
                why: gameMessage("games", "lib.modWhy.tame"),
                kind: "mod"
            },
            {
                id: "889745138",
                name: "Awesome Teleporters!",
                why: gameMessage("games", "lib.modWhy.teleport"),
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
                why: gameMessage("games", "lib.modWhy.building"),
                kind: "mod"
            },
            {
                id: "821530042",
                name: "Upgrade Station",
                why: gameMessage("games", "lib.modWhy.gear"),
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
                why: gameMessage("games", "lib.modWhy.flyers"),
                kind: "mod"
            },
            {
                id: "1251632107",
                name: "Immersive Taming",
                why: gameMessage("games", "lib.modWhy.taming"),
                kind: "mod"
            },
            {
                id: "632898827",
                name: "Dino Colors Plus",
                why: gameMessage("games", "lib.modWhy.colors"),
                kind: "mod"
            }
        ]
    },
    {
        group: gameMessage("games", "lib.modShelves.bigger"),
        entries: [
            {
                id: "1169020368",
                name: "Ark Creatures Rebalanced (AG Reborn)",
                why: gameMessage("games", "lib.modWhy.overhaul"),
                kind: "mod"
            },
            {
                id: "1523045986",
                name: "Additional Creatures 2: Paranoia!",
                why: gameMessage("games", "lib.modWhy.creatures"),
                kind: "mod"
            },
            {
                id: "916417001",
                name: "Ebenus Astrum",
                why: gameMessage("games", "lib.modWhy.map"),
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
