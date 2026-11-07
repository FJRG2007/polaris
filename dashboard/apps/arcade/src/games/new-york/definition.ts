import { Building2 } from "lucide-react";
import type { GameDefinition } from "../types";

/**
 * A city to explore on foot, by car, by bike or by helicopter. Its cover is a
 * drawn skyline at dusk (`game/new-york/cover.svg`), shipped by the build next
 * to the game's page.
 */
export const newYork: GameDefinition = {
    id: "new-york",
    icon: Building2,
    multiplayer: true,
    cover: "cover.svg"
};
