/**
 * What makes Polaris installable as an app of its own.
 *
 * Installed from the browser, Polaris opens in its own window with its own icon
 * in the dock, the taskbar or the home screen - on Windows, macOS, Linux,
 * ChromeOS and Android alike - and stays whatever version the instance is
 * running, because it is the instance. Nothing to download, sign or keep
 * updated separately; the native app in `desktop/` is the download for what a
 * browser window cannot do.
 *
 * The icons wear the season on the server's date (`serverSeason`), at
 * addresses that name it, so a changed season is a changed manifest. How far
 * that reaches is the browser's call: Chrome on Android rebuilds the installed
 * app's icon in the background a day or so later; Chrome on desktop does not
 * apply icon changes to an installed app at all yet, and keeps the one it was
 * installed with.
 *
 * The colours are the dark theme's background (`--background` in the design
 * tokens), the one a window opens on before the page has painted.
 */

import type { MetadataRoute } from "next";
import { serverSeason } from "@/lib/seasonal-service";
import { seasonIconPng, seasonIconSvg } from "@/lib/season-icon";

export default async function manifest(): Promise<MetadataRoute.Manifest> {
    const season = await serverSeason().catch(() => null);
    return {
        id: "/",
        name: "Polaris",
        short_name: "Polaris",
        // i18n-ignore: the install manifest is built once and cached by browsers, not drawn per reader
        description: "Your home lab and servers: deploys, drive, mail, chat and more.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#0b0c0e",
        theme_color: "#0b0c0e",
        icons: [
            { src: seasonIconSvg(season), sizes: "any", type: "image/svg+xml", purpose: "any" },
            { src: seasonIconPng(season, 128), sizes: "128x128", type: "image/png", purpose: "any" },
            { src: seasonIconPng(season, 192), sizes: "192x192", type: "image/png", purpose: "any" },
            { src: seasonIconPng(season, 512), sizes: "512x512", type: "image/png", purpose: "any" }
        ],
        // The same address the Mail settings register for mailto links, so an
        // installed Polaris is offered as the mail app too.
        protocol_handlers: [{ protocol: "mailto", url: "/mail/compose?url=%s" }]
    };
}
