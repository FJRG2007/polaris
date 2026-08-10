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

export interface ArkMap {
    /** The level name the server is launched with. Case sensitive. */
    readonly value: string;
    readonly label: string;
    /** Whether it needs the DLC that ships it. A player without it cannot join,
     *  which is worth saying before the world is generated rather than after. */
    readonly dlc: boolean;
}

export const ARK_MAPS: readonly ArkMap[] = [
    { value: "TheIsland", label: "The Island", dlc: false },
    { value: "TheCenter", label: "The Center", dlc: false },
    { value: "Ragnarok", label: "Ragnarok", dlc: false },
    { value: "Valguero_P", label: "Valguero", dlc: false },
    { value: "CrystalIsles", label: "Crystal Isles", dlc: false },
    { value: "LostIsland", label: "Lost Island", dlc: false },
    { value: "Fjordur", label: "Fjordur", dlc: false },
    { value: "ScorchedEarth_P", label: "Scorched Earth", dlc: true },
    { value: "Aberration_P", label: "Aberration", dlc: true },
    { value: "Extinction", label: "Extinction", dlc: true },
    { value: "Genesis", label: "Genesis: Part 1", dlc: true },
    { value: "Gen2", label: "Genesis: Part 2", dlc: true }
];

export const DEFAULT_ARK_MAP = "TheIsland";

/** Whether a level name is one of the maps that ship with the game. */
export function isArkMap(value: string): boolean {
    return ARK_MAPS.some((map) => map.value === value);
}

export function findArkMap(value: string): ArkMap | undefined {
    return ARK_MAPS.find((map) => map.value === value);
}
