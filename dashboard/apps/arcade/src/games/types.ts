import type { LucideIcon } from "lucide-react";

export interface GameDefinition {
    /** Its folder, its asset directory and its key in the messages. */
    readonly id: string;
    readonly icon: LucideIcon;
    /** Whether people in a call can play it together. */
    readonly multiplayer: boolean;
    /**
     * Rooms: opened from the game's own page and joined by a code, an invite
     * or the public list, and how many may play in one. Declaring it is all a
     * game does to have them; a game without it shows nothing of rooms.
     */
    readonly rooms?: { readonly maxPlayers: number };
    /**
     * Its cover for the library: an image file in the game's own folder
     * (`game/<id>/`), shown 16:9. A game without one shows a placeholder card.
     */
    readonly cover?: string;
}
