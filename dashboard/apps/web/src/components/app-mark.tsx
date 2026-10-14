"use client";

/**
 * An app's own mark, wherever one is drawn.
 *
 * Every card in the marketplace wore a line-drawing from the icon set - a little
 * grey gamepad for Minecraft, a grey chat bubble for the messaging bridge - which
 * is what a category looks like, not what an app looks like. A store where every
 * shelf is the same six glyphs is a store nobody can scan.
 *
 * **A real logo is used where Polaris already has the official one**, from
 * `brand-icons`, which holds marks taken from each project's own assets. Nothing
 * is drawn from memory and nothing is fetched at runtime: an app whose logo
 * Polaris does not have keeps its icon, on a tile tinted from its own id so at
 * least two of them are tellable apart before their names are read. That is a
 * deliberately boring fallback rather than a guess at somebody's brand.
 *
 * The tint is `tintFor`, the same function behind every face in Polaris, so an
 * app and a person drawn side by side are coloured by the same rule.
 */

import { AppLogo, cn, hasAppLogo } from "@polaris/ui";
import type { JSX, SVGProps } from "react";
import { initialsInk, tintFor } from "@polaris/core";
import type { AppManifest } from "@/lib/apps/catalog";
import { DiscordMark, SteamMark } from "@/components/brand-icons";

/**
 * The marks Polaris holds that belong to an app in the catalog.
 *
 * Keyed by catalog id rather than guessed from the name, so adding an app never
 * silently borrows somebody else's logo. Only where the mark is genuinely that
 * project's: ARK and FiveM are distributed through Steam and Cfx.re
 * respectively, and Polaris has no asset for either, so they are not here and
 * they keep their icon.
 */
const BRAND_MARKS: Record<string, (props: SVGProps<SVGSVGElement>) => JSX.Element> = {
    // The bridge speaks to several platforms; the one Polaris has an asset for
    // is Discord, and it is the one most operators recognise the app by.
    "messaging-bridge": DiscordMark,
    // ARK is a Steam title and the app installs a Steam-based server image.
    ark: SteamMark,
    "ark-manager": SteamMark
};

/**
 * Catalog entries that install one of Polaris's own apps, by the app id they
 * become. They wear that app's logo here too, so the card in the store is the
 * tile the launcher will show once it is installed.
 */
const OWN_APPS: Readonly<Record<string, string>> = {
    tools: "tools",
    calendar: "calendar",
    crm: "crm",
    home: "home",
    "game-servers": "games"
};

export function AppMark({
    app,
    size = 36,
    className
}: {
    app: AppManifest;
    size?: number;
    className?: string;
}) {
    const Brand = BRAND_MARKS[app.id];
    const Icon = app.icon;

    const own = OWN_APPS[app.id];
    if (own && hasAppLogo(own)) {
        return (
            <span
                className={cn("grid shrink-0 place-items-center", className)}
                style={{ width: size, height: size }}
            >
                <AppLogo appId={own} size={Math.round(size * 0.9)} />
            </span>
        );
    }

    if (Brand) {
        return (
            <span
                className={cn(
                    "border-border bg-surface grid shrink-0 place-items-center rounded-md",
                    className
                )}
                style={{ width: size, height: size }}
            >
                <Brand style={{ width: size * 0.55, height: size * 0.55 }} />
            </span>
        );
    }

    return (
        <span
            className={cn("grid shrink-0 place-items-center rounded-md", className)}
            // Its own colour rather than the same grey tile for all of them: two
            // apps in a row have to be tellable apart before either name is read,
            // and the id is stable so an app is the same colour on every screen.
            style={{
                width: size,
                height: size,
                backgroundColor: tintFor(app.id),
                color: initialsInk(tintFor(app.id))
            }}
        >
            <Icon style={{ width: size * 0.5, height: size * 0.5 }} />
        </span>
    );
}
