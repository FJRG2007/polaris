import type { DriveEntry } from "./types";
import { readListing } from "./listing-cache";

/**
 * The folder a breadcrumb segment names, as the row the listing would show for
 * it - so its right-click menu is the very menu that row gets.
 *
 * Taken from the parent's listing when this tab has read it (favorite, hidden,
 * icon and note then read true), else made from the path alone: a segment is
 * always a folder, and what is not known about it is simply not set.
 */
export function crumbEntry(connectionId: string, path: string): DriveEntry {
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const listed = readListing(connectionId, parent)?.find((entry) => entry.path === path);
    if (listed) return listed;
    return {
        name: path.split("/").pop() ?? path,
        path,
        kind: "dir",
        size: "0",
        modifiedAt: "",
        createdAt: ""
    };
}
