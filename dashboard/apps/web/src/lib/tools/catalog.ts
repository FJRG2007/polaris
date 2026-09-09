/**
 * What Tools contains, grouped the way somebody actually arrives at it.
 *
 * Not one entry per verb. Somebody with a photo in their hand wants it smaller,
 * or in another format, or three hundred kilobytes lighter, and finding out
 * which of those they want is part of doing it - so those are one screen with a
 * picture on it, not three screens with three uploads. The same is true of a
 * document and of a video. What is grouped here is the thing you have, not the
 * operation you were going to perform on it.
 *
 * One list, read by the app's front page, by the switcher inside it, and by
 * search - so a tool that exists is a tool that can be found, and a tool that is
 * removed disappears from all three at once.
 */

import type { Permission } from "@polaris/core";
import { FileText, Image as ImageIcon, Link2, Video, type LucideIcon } from "lucide-react";

export interface ToolGroup {
    readonly id: string;
    readonly name: string;
    /** What somebody is holding when they come here. */
    readonly subject: string;
    readonly icon: LucideIcon;
    readonly href: string;
    /** The jobs this screen does, for the card and for search. Written as things
     *  somebody would say they want, not as feature names. */
    readonly does: readonly string[];
    /** What it costs to open. Everything is `tools.use` except the one that
     *  publishes an address. */
    readonly permission: Permission;
    /** Not built yet. Listed rather than hidden: somebody looking for it should
     *  find out it is coming here, rather than concluding Polaris cannot do it
     *  and going to a website that can. */
    readonly soon?: boolean;
}

export const TOOL_GROUPS: readonly ToolGroup[] = [
    {
        id: "images",
        name: "Images",
        subject: "A picture",
        icon: ImageIcon,
        href: "/tools/images",
        does: [
            "Convert between JPEG, PNG, WebP and AVIF",
            "Resize, by size or by how much of it you want",
            "Make it smaller without it looking worse",
            "Read what the file says about itself"
        ],
        permission: "tools.use"
    },
    {
        id: "documents",
        name: "Documents",
        subject: "A document",
        icon: FileText,
        href: "/tools/documents",
        does: [
            "Turn a PDF into an editable Word document",
            "Pull the text out of almost anything",
            "Turn a spreadsheet into CSV, and back",
            "Read what the file says about itself"
        ],
        permission: "tools.use",
        soon: true
    },
    {
        id: "video",
        name: "Video",
        subject: "A video",
        icon: Video,
        href: "/tools/video",
        does: [
            "Trim the start, the end, or a piece out of the middle",
            "Silence it, or take one clip out of it",
            "Blur a face, a plate or a screen",
            "Crop to what matters"
        ],
        permission: "tools.use",
        soon: true
    },
    {
        id: "links",
        name: "Links & text",
        subject: "A link, or a passage",
        icon: Link2,
        href: "/tools/links",
        does: [
            "Shorten a link to one this Polaris answers",
            "See how many people followed it",
            "Translate a passage using the providers this Polaris has"
        ],
        permission: "tools.use",
        soon: true
    }
];

/** One group by its id, for the screens under it. */
export function toolGroup(id: string): ToolGroup | undefined {
    return TOOL_GROUPS.find((group) => group.id === id);
}
