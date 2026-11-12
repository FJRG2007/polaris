/**
 * `/llms.txt`: the site described for a language model or an agent, in the
 * shape llmstxt.org proposes - a title, a one-line summary, then sections of
 * links with a short note each.
 *
 * Built from the same generated data the pages are, so a guide added under
 * `docs/features` or an app added to the catalogue is listed here on the next
 * build, and the links never point at a page that was not exported. The
 * repository map is the one part written by hand: it names folders, and a test
 * checks that each one still exists.
 */

import type { SiteData } from "@/data/builders";
import { apiPath } from "./api-pages";

/** Where things live in the repository, for an agent that has to change one. */
export const REPOSITORY_MAP: readonly { readonly path: string; readonly what: string }[] = [
    { path: "dashboard/apps/web", what: "The dashboard: the Next.js app every Polaris runs, its API routes, server actions and translations (messages/)" },
    { path: "dashboard/apps/web/src/lib", what: "Server-side services, one module per domain (deploy, drive, chat, auth, domains, ...)" },
    { path: "dashboard/apps/web/test", what: "The dashboard's tests, in folders that mirror the source" },
    { path: "dashboard/packages/auth", what: "Sign-in, sessions, second factors and passkeys" },
    { path: "dashboard/packages/core", what: "Shared schemas, constants and pure helpers" },
    { path: "dashboard/packages/db", what: "The Prisma schema and its migrations" },
    { path: "dashboard/packages/ui", what: "The design system's components" },
    { path: "dashboard/apps/site", what: "This website, generated from the repository at build time" },
    { path: "dashboard/apps/extension", what: "The browser extension" },
    { path: "dashboard/cli", what: "The `polaris` command installed on the host (POSIX and Windows)" },
    { path: "dashboard/docker", what: "The Docker Compose stack an install runs" },
    { path: "dashboard/scripts", what: "The installer, the updater and their tests" },
    { path: "crates/polaris-hostd", what: "The host daemon that runs containers for the dashboard" },
    { path: "desktop", what: "The desktop app" },
    { path: "tv", what: "Polaris on TVs" },
    { path: "docs/features", what: "The guides this site's Docs section is rendered from, in English and Spanish" },
    { path: "docs/developers", what: "MCP, analytics and telemetry for developers" }
];

/**
 * The text, with every link absolute. `site` is the site's root with its base
 * path and no trailing slash, such as `https://fjrg2007.github.io/polaris`.
 */
export function llmsText(
    data: Pick<SiteData, "repo" | "install" | "docs" | "locales"> & { api: Pick<SiteData["api"], "groups"> },
    site: string,
    summary: string
): string {
    const repo = `https://github.com/${data.repo}`;
    const lines: string[] = ["# Polaris", "", `> ${summary}`, ""];

    lines.push(
        "Polaris is self-hosted: one install script puts it on a machine, and it is",
        "run and updated from its own interface. English pages are under /en/ and",
        "Spanish under /es/; each guide's Markdown source is linked beside it.",
        ""
    );

    if (data.install.unix || data.install.windows) {
        lines.push("## Install", "");
        if (data.install.unix) lines.push(`- Linux and macOS: \`${data.install.unix}\``);
        if (data.install.windows) lines.push(`- Windows: \`${data.install.windows}\``);
        lines.push("");
    }

    lines.push("## Docs", "");
    for (const page of data.docs.en) {
        const note = page.summary ? `: ${page.summary}` : "";
        lines.push(`- [${page.title}](${site}/en/docs/${page.slug}/)${note} (source: ${repo}/blob/main/${page.source})`);
    }
    lines.push("");

    lines.push(
        "## API",
        "",
        `- [API reference](${site}/en/docs/api/): authentication, base address and the errors every call shares`,
        ...data.api.groups.flatMap((group) => [
            `- [${group.tag}](${site}/en/${apiPath.group(group.tag)}): ${group.operations.length} call${group.operations.length === 1 ? "" : "s"}`,
            ...group.operations.map(
                (op) => `  - [${op.method} ${op.path}](${site}/en/${apiPath.operation(op)})${op.summary ? `: ${op.summary}` : ""}`
            )
        ]),
        `- [OpenAPI document](${site}/openapi.json): the same routes as OpenAPI 3`,
        ""
    );

    const apps = [...data.locales.en.builtIn, ...data.locales.en.apps];
    if (apps.length > 0) {
        lines.push("## Apps", "");
        for (const app of apps) {
            const about = "summary" in app ? app.summary : app.description;
            lines.push(`- [${app.name}](${site}/en/marketplace/${app.id}/): ${about}`);
        }
        lines.push("");
    }

    lines.push("## Repository", "", `- [Source](${repo})`);
    for (const entry of REPOSITORY_MAP) lines.push(`- [${entry.path}](${repo}/tree/main/${entry.path}): ${entry.what}`);
    lines.push("");

    lines.push(
        "## Optional",
        "",
        `- [Downloads](${site}/en/downloads/): desktop app, browser extension, CLI, Stream Deck`,
        `- [Spanish site](${site}/es/)`,
        `- [Sitemap](${site}/sitemap.xml)`
    );

    return `${lines.join("\n").replace(/\s+$/, "")}\n`;
}
