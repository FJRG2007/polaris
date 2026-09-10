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
 * The colours are the dark theme's background (`--background` in the design
 * tokens), the one a window opens on before the page has painted.
 */

import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
    return {
        id: "/",
        name: "Polaris",
        short_name: "Polaris",
        description: "Your home lab and servers: deploys, drive, mail, chat and more.",
        start_url: "/home",
        scope: "/",
        display: "standalone",
        background_color: "#0b0c0e",
        theme_color: "#0b0c0e",
        icons: [
            { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
            { src: "/polaris-mark-128.png", sizes: "128x128", type: "image/png", purpose: "any" }
        ],
        // The same address the Mail settings register for mailto links, so an
        // installed Polaris is offered as the mail app too.
        protocol_handlers: [{ protocol: "mailto", url: "/mail/compose?url=%s" }]
    };
}
