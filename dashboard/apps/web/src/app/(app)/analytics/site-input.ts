/**
 * What somebody types when adding a site run elsewhere, and the tracker tag for
 * each kind of project it might be pasted into.
 *
 * Neutral - no "use client", no "use server" - so the form validates as it is
 * typed against the same schema the action enforces, and a value exported from
 * an action module (which may only export functions) is not needed.
 */

import { z } from "zod";

/** A hostname as typed, reduced to the bare host: no scheme, path, port or case. */
export function bareHost(raw: string): string {
    const trimmed = raw
        .trim()
        .toLowerCase()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
    return (trimmed.split(/[/?#]/)[0] ?? "").replace(/:\d+$/, "").replace(/\.$/, "");
}

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Shared by the form and the action, so both refuse the same things. */
export const externalSiteSchema = z.object({
    name: z.string().trim().min(1).max(80),
    hostname: z.string().max(260).transform(bareHost).pipe(z.string().regex(HOSTNAME))
});

export type ExternalSiteInput = z.input<typeof externalSiteSchema>;

/** The kinds of project the setup has instructions for. */
export const TRACKER_FRAMEWORKS = ["html", "nextjs", "react", "vue", "astro", "wordpress", "gtm"] as const;
export type TrackerFramework = (typeof TRACKER_FRAMEWORKS)[number];

/** The grammar each variant of the tag is painted in. */
export const TRACKER_LANGUAGE: Record<TrackerFramework, string> = {
    html: "html",
    nextjs: "javascript",
    react: "html",
    vue: "html",
    astro: "html",
    wordpress: "php",
    gtm: "html"
};

/**
 * The tag, written the way each kind of project expects it. Every variant loads
 * the same script with the same key; only where it goes and how it is spelled
 * differ.
 */
export function trackerSnippet(framework: TrackerFramework, baseUrl: string, key: string): string {
    const src = `${baseUrl}/analytics.js`;
    const tag = `<script defer fetchpriority="low" src="${src}" data-key="${key}"></script>`;
    switch (framework) {
        case "nextjs":
            return [
                "import Script from \"next/script\";",
                "",
                "// app/layout.tsx, inside <body>",
                `<Script src="${src}" data-key="${key}" strategy="afterInteractive" />`
            ].join("\n");
        case "react":
            return ["<!-- public/index.html or index.html, inside <head> -->", tag].join("\n");
        case "vue":
            return ["<!-- index.html, inside <head> -->", tag].join("\n");
        case "astro":
            return ["---", "// src/layouts/Layout.astro, inside <head>", "---", tag.replace("<script ", "<script is:inline ")].join(
                "\n"
            );
        case "wordpress":
            return [
                "// functions.php of your theme, or a code snippets plugin",
                "add_action(\"wp_head\", function () {",
                `    echo '${tag}';`,
                "});"
            ].join("\n");
        case "gtm":
            return [
                "<!-- Google Tag Manager: Tags > New > Custom HTML, trigger All Pages -->",
                "<script>",
                "    (function () {",
                "        var s = document.createElement(\"script\");",
                "        s.defer = true;",
                `        s.src = "${src}";`,
                `        s.setAttribute("data-key", "${key}");`,
                "        document.head.appendChild(s);",
                "    })();",
                "</script>"
            ].join("\n");
        default:
            return tag;
    }
}
