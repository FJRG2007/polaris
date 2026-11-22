"use client";

/**
 * One item's picture, at whatever size the caller draws its slot.
 *
 * The vanilla set is named after the item id, so there is no lookup - but it is a
 * set of a particular Minecraft version, and a server can hold an item newer than
 * it or an item from a mod. A modded one is drawn from what was read out of that
 * mod's jar, which the panel holds in a map the icons subscribe to: a bag full of
 * SecurityCraft fills in as soon as that arrives, without every slot having to
 * know which server it belongs to.
 *
 * Anything left over resolves to a URL that is not there, and a broken image in a
 * slot reads as a bug in the panel rather than as an item nobody drew yet, so a
 * failed load falls back to a neutral block.
 *
 * `pixelated` because these are 16x16 textures shipped at 64x64: smoothed up to a
 * slot they turn into the blur that every Minecraft screenshot is not.
 */

import { cn } from "@polaris/ui";
import { Package } from "lucide-react";
import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import { itemIconUrl, pictureFit } from "../../lib/minecraft/items";
import {
    ItemServer,
    loadModItems,
    modItemPictureFor,
    modItemsVersion,
    noModItems,
    subscribeModItems
} from "./minecraft-mod-items";

export function ItemIcon({
    id,
    tag,
    className
}: {
    id: string;
    /** The item's data as SNBT, for an item whose picture follows a tag. */
    tag?: string | null;
    className?: string;
}) {
    // Keyed by the picture's address rather than a bare boolean: the same icon
    // element is reused as a picker's results change under it, and a flag left
    // over from the previous item - or the previous gun of the same item - would
    // blank out the next one.
    const [failed, setFailed] = useState<string | null>(null);
    // Re-read whenever a server's modded catalogue lands, which is what turns the
    // placeholder in an already-drawn slot into the real picture.
    useSyncExternalStore(subscribeModItems, modItemsVersion, noModItems);

    const picture = modItemPictureFor(id, tag);
    // A modded item's picture comes from that server's catalogue, which nothing
    // else may have asked for yet - a player's inventory is drawn without the
    // palette ever opening. The load is shared and cached per server, so a bag of
    // forty modded slots is still one request.
    const server = useContext(ItemServer);
    const modded = isModded(id);
    useEffect(() => {
        if (server !== null && modded) void loadModItems(server);
    }, [server, modded]);
    const url = picture?.url ?? itemIconUrl(id);

    if (url === null || failed === url) {
        return <Package className={cn("text-muted-foreground/70", className)} aria-hidden />;
    }

    // A mod texture is not always a square: an animated one is a column of frames
    // and a connected one a row of variants. Drawn whole it is a smear, so the
    // first square of it is scaled up and the rest is clipped - which is the frame
    // the game itself shows on the item.
    const fit = picture ? pictureFit(picture) : null;
    if (fit === null) {
        return (
            <img
                src={url}
                alt=""
                loading="lazy"
                decoding="async"
                draggable={false}
                onError={() => setFailed(url)}
                className={cn("[image-rendering:pixelated] select-none object-contain", className)}
            />
        );
    }
    return (
        <span className={cn("relative block overflow-hidden", className)}>
            <img
                src={url}
                alt=""
                loading="lazy"
                decoding="async"
                draggable={false}
                style={fit}
                onError={() => setFailed(url)}
                className="absolute start-0 top-0 max-w-none select-none [image-rendering:pixelated]"
            />
        </span>
    );
}

/** An id from a namespace other than the game's own. */
function isModded(id: string): boolean {
    const colon = id.indexOf(":");
    return colon > 0 && id.slice(0, colon) !== "minecraft";
}
