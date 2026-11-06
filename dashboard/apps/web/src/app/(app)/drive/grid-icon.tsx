"use client";

/**
 * A grid tile's picture or icon, shared by Drive's explorer and the file picker
 * so a folder looks the same in both.
 */

import { cn } from "@polaris/ui";
import { Folder } from "lucide-react";
import type { DriveEntry } from "./types";
import { fileIconFor } from "./file-icons";
import { EntryThumbnail } from "./entry-thumbnail";
import { iconColorClass, iconComponent } from "./item-icons";
import { drawsItsOwnFrame, thumbnailKind } from "@/lib/drive-thumbnail-kind";

/** What a tile needs to know about an entry. A listing that carries no user-set
 *  icon simply leaves it out. */
export type TileEntry = Pick<DriveEntry, "name" | "kind" | "size" | "modifiedAt"> &
    Partial<Pick<DriveEntry, "icon" | "iconColor">>;

/** The box a tile's picture or icon sits in. One value, because the two are
 *  interchangeable inside a grid and a grid whose rows differ by file type is
 *  one nobody can read down. */
const THUMBNAIL_BOX = "size-14";

/**
 * A tile's picture, or its icon.
 *
 * Only a file whose name could produce one is wrapped at all, so a folder or a
 * spreadsheet costs nothing to decide - not a request, not an observer, not an
 * element. Both branches occupy the same box, so a grid of documents lines up
 * with a grid of photographs and nothing reflows when a picture arrives after
 * the icon it replaces.
 */
export function GridIcon({
    connectionId,
    entry,
    path,
    className = THUMBNAIL_BOX,
    iconClassName = "size-10"
}: {
    connectionId: string;
    entry: TileEntry & { path: string };
    /** Where the file actually is, when that is not `entry.path` (a binned item). */
    path?: string;
    /** How much room the picture gets. A tile in the grid and the details panel
     *  want different amounts of it and nothing else about them differs. */
    className?: string;
    iconClassName?: string;
}) {
    const icon = <EntryIcon entry={entry} className={iconClassName} />;
    // A picture the server draws, or a frame the browser draws for itself.
    const moving = entry.kind === "file" && drawsItsOwnFrame(entry.name);
    if (entry.kind !== "file" || (!thumbnailKind(entry.name) && !moving)) {
        return <span className={cn(className, "flex items-center justify-center")}>{icon}</span>;
    }
    return (
        <EntryThumbnail
            connectionId={connectionId}
            path={path ?? entry.path}
            version={`${entry.modifiedAt}-${entry.size}`}
            moving={moving}
            className={className}
        >
            {icon}
        </EntryThumbnail>
    );
}

/** The icon for an entry: a user-set one, else the folder mark or the file type's. */
export function EntryIcon({
    entry,
    className = "size-4"
}: {
    entry: TileEntry;
    className?: string;
}) {
    const Custom = iconComponent(entry.icon);
    if (Custom) return <Custom className={cn(className, iconColorClass(entry.iconColor))} />;
    if (entry.kind === "dir") return <Folder className={cn(className, "text-primary")} />;
    const { icon: Icon, className: color } = fileIconFor(entry.name);
    return <Icon className={cn(className, color)} />;
}
