import { Building2 } from "lucide-react";
import type { GameDefinition } from "../types";

/**
 * A city to explore on foot, by car, by bike or by helicopter. No `cover` yet:
 * no screenshot of it exists that could be shipped, so the library shows its
 * placeholder card.
 */
export const newYork: GameDefinition = { id: "new-york", icon: Building2, multiplayer: true };
