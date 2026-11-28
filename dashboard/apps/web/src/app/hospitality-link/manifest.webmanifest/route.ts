/**
 * The install manifest of a Hospitality device: added to the home screen of a
 * handheld, a till or a kitchen tablet, it opens full screen straight into
 * `/hospitality-link` (the code to link it, then service or the kitchen), a
 * window of its own apart from Polaris itself.
 */

import { serverSeason } from "@/lib/seasonal-service";
import { seasonIconPng, seasonIconSvg } from "@/lib/season-icon";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const season = await serverSeason().catch(() => null);
    const manifest = {
        id: "/hospitality-link",
        name: "Polaris Hospitality",
        short_name: "Hospitality",
        start_url: "/hospitality-link",
        scope: "/hospitality-link",
        display: "standalone",
        // A handheld stays upright; a kitchen tablet turns as it is mounted.
        orientation: "any",
        background_color: "#0b0c0e",
        theme_color: "#0b0c0e",
        icons: [
            { src: seasonIconSvg(season), sizes: "any", type: "image/svg+xml", purpose: "any" },
            { src: seasonIconPng(season, 192), sizes: "192x192", type: "image/png", purpose: "any" },
            { src: seasonIconPng(season, 512), sizes: "512x512", type: "image/png", purpose: "any" }
        ]
    };
    return new Response(JSON.stringify(manifest), {
        headers: { "content-type": "application/manifest+json", "cache-control": "no-cache" }
    });
}
