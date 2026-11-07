import type { LucideIcon } from "lucide-react";

export interface GameDefinition {
    /** Its folder, its asset directory and its key in the messages. */
    readonly id: string;
    readonly icon: LucideIcon;
    /** Whether people in a call can play it together. */
    readonly multiplayer: boolean;
    /**
     * Its cover for the library: an image file in the game's own folder
     * (`game/<id>/`), shown 16:9. A game without one shows a placeholder card.
     */
    readonly cover?: string;
}
