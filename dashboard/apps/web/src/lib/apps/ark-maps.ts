/**
 * The maps an ARK server can be created on.
 *
 * The value is the level name the dedicated server is launched with, and it is
 * not the name anybody calls the map: four of them carry a suffix (`_P`) and one
 * is abbreviated outright (`Gen2`). They are also case sensitive, so a map picked
 * from a list is the only way an operator gets one right - which is why this is a
 * closed set rather than a text field, on the form and on the settings screen
 * both.
 *
 * Only the maps that ship with the game. A modded map is a workshop id and a
 * different setting (`SERVER_MAP_MOD_ID`), not another entry here.
 */

/**
 * What a player needs before they can join a server on this map.
 *
 * Three states rather than two, because "free" and "already installed" are not
 * the same thing and treating them as one is worth an evening. Only The Island
 * comes with the game. The rest are separate downloads, and a player who joins a
 * server on one they have not installed is bounced back to the main menu while
 * Steam opens on the store page - no message, nothing naming the map, and from
 * the operator's side it looks exactly like a server that refuses connections.
 */
export type ArkMapRequirement = "base" | "free" | "paid";

export interface ArkMap {
    /** The level name the server is launched with. Case sensitive. */
    readonly value: string;
    readonly label: string;
    readonly requires: ArkMapRequirement;
}

export const ARK_MAPS: readonly ArkMap[] = [
    { value: "TheIsland", label: "The Island", requires: "base" },
    { value: "TheCenter", label: "The Center", requires: "free" },
    { value: "Ragnarok", label: "Ragnarok", requires: "free" },
    { value: "Valguero_P", label: "Valguero", requires: "free" },
    { value: "CrystalIsles", label: "Crystal Isles", requires: "free" },
    { value: "LostIsland", label: "Lost Island", requires: "free" },
    { value: "Fjordur", label: "Fjordur", requires: "free" },
    { value: "ScorchedEarth_P", label: "Scorched Earth", requires: "paid" },
    { value: "Aberration_P", label: "Aberration", requires: "paid" },
    { value: "Extinction", label: "Extinction", requires: "paid" },
    { value: "Genesis", label: "Genesis: Part 1", requires: "paid" },
    { value: "Gen2", label: "Genesis: Part 2", requires: "paid" }
];

/** What to tell somebody choosing this map, in the terms the player will meet it. */
export function mapRequirementHint(map: ArkMap | undefined): string {
    if (!map) return "";
    if (map.requires === "paid") return "Only players who own that DLC can join.";
    if (map.requires === "free") {
        return "Free, but every player has to install it in Steam first - ARK sends them back to the menu otherwise.";
    }
    return "Comes with the game, so anybody can join.";
}

export const DEFAULT_ARK_MAP = "TheIsland";

/** Whether a level name is one of the maps that ship with the game. */
export function isArkMap(value: string): boolean {
    return ARK_MAPS.some((map) => map.value === value);
}

export function findArkMap(value: string): ArkMap | undefined {
    return ARK_MAPS.find((map) => map.value === value);
}
