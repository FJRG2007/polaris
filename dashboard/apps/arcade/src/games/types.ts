import type { LucideIcon } from "lucide-react";

export interface GameDefinition {
    /** Its folder, its asset directory and its key in the messages. */
    readonly id: string;
    readonly icon: LucideIcon;
    /** Whether people in a call can play it together. */
    readonly multiplayer: boolean;
}
