/**
 * The feature guides in `docs/features`, turned into site pages at build time,
 * and the request examples the API reference shows. Pure functions, so the
 * rewriting rules can be asserted without a build.
 */

import type { ApiOperation } from "@/data/builders";

export interface DocHeading {
    readonly id: string;
    readonly text: string;
}

export interface DocPage {
    readonly slug: string;
    /** The file it was rendered from, as a path in the repository. */
    readonly source: string;
    readonly title: string;
    /** The first paragraph, for the index and the page's description. */
    readonly summary: string;
    readonly headings: readonly DocHeading[];
    /** Rendered from the repository's own Markdown at build time. */
    readonly html: string;
    /** The section text by heading id, for the search index. */
    readonly text: Readonly<Record<string, string>>;
}

/** `game-servers.es.md` as `game-servers`. */
export function docSlug(file: string): string {
    return file.replace(/(\.es)?\.md$/, "");
}

/** A heading's anchor: lowercase words joined by dashes, accents dropped. */
export function headingId(text: string): string {
    return text
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

/**
 * The guide without its own header: the `# Title` line and the line under it
 * that links the other language and the README, which the site draws itself.
 */
export function splitDoc(markdown: string): { title: string; body: string } {
    const lines = markdown.replace(/\r\n/g, "\n").split("\n");
    const at = lines.findIndex((line) => /^# /.test(line));
    const title = at >= 0 ? lines[at]!.slice(2).trim() : "";
    let rest = at >= 0 ? lines.slice(at + 1) : lines;
    const first = rest.findIndex((line) => line.trim() !== "");
    if (first >= 0 && /\]\([^)]*README(?:\.es)?\.md\)/.test(rest[first]!))
        rest = rest.slice(first + 1);
    return { title, body: rest.join("\n").trim() };
}

/** Text with its tags removed and its entities read, for summaries and search. */
export function plainText(html: string): string {
    return html
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Every link and picture in a rendered guide, pointed at where it lives on the
 * site. Paths are relative to the page (`/<locale>/docs/<slug>/`), so they work
 * under any base path: another guide is a sibling page, a picture is in the
 * site's media folder, anything else in the repository opens on GitHub.
 */
export function rewriteDocLinks(
    html: string,
    {
        slugs,
        repo,
        dir,
        paths
    }: {
        slugs: ReadonlySet<string>;
        repo: string;
        dir: string;
        /** Guides outside `docs/features` that have a page, by their repository path. */
        paths?: ReadonlyMap<string, string>;
    }
): { html: string; media: string[] } {
    const media = new Set<string>();
    const target = (url: string): string => {
        if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(url)) return url;
        const [path = "", hash = ""] = url.split("#");
        const anchor = hash ? `#${hash}` : "";
        const name = path.split("/").pop() ?? "";
        const picture = /(?:^|\/)assets\/media\/([^/]+)$/.exec(path);
        if (picture) {
            media.add(picture[1]!);
            return `../../../media/${picture[1]}`;
        }
        const logo = /(?:^|\/)assets\/logos\/([^/]+)$/.exec(path);
        if (logo) return `../../../logos/${logo[1]}`;
        if (!path.includes("/") && /\.md$/.test(name) && slugs.has(docSlug(name)))
            return `../${docSlug(name)}/${anchor}`;
        if (!path) return anchor;
        // Resolve against the guide's folder in the repository.
        const parts = `${dir}/${path}`.split("/");
        const resolved: string[] = [];
        for (const part of parts) {
            if (part === "..") resolved.pop();
            else if (part && part !== ".") resolved.push(part);
        }
        const page = paths?.get(resolved.join("/"));
        if (page) return `../${page}/${anchor}`;
        return `https://github.com/${repo}/blob/main/${resolved.join("/")}${anchor}`;
    };
    const out = html
        .replace(
            /\b(href|src)="([^"]*)"/g,
            (_, attr: string, url: string) => `${attr}="${target(url)}"`
        )
        .replace(
            /\bsrcset="([^"]*)"/g,
            (_, set: string) =>
                `srcset="${set
                    .split(",")
                    .map((entry) => {
                        const [url = "", ...size] = entry.trim().split(/\s+/);
                        return [target(url), ...size].join(" ");
                    })
                    .join(", ")}"`
        );
    return { html: out, media: [...media] };
}

/** A group of guides in the sidebar, in the order they are read. */
export interface DocSection {
    readonly label: string;
    readonly slugs: readonly string[];
}

/**
 * The README's own grouping of the feature guides: every `###` heading that
 * links at least one `docs/features` guide, with those guides in the order the
 * README links them. A guide linked twice stays in the first group.
 */
export function readmeSections(readme: string): DocSection[] {
    const sections: { label: string; slugs: string[] }[] = [];
    const seen = new Set<string>();
    let current: { label: string; slugs: string[] } | null = null;
    for (const line of readme.replace(/\r\n/g, "\n").split("\n")) {
        const heading = /^(#{2,3}) (.+)$/.exec(line);
        if (heading) {
            current = heading[1] === "###" ? { label: heading[2]!.trim(), slugs: [] } : null;
            if (current) sections.push(current);
            continue;
        }
        if (!current) continue;
        for (const match of line.matchAll(/docs\/features\/([a-z0-9-]+)(?:\.es)?\.md/g)) {
            const slug = match[1]!;
            if (seen.has(slug)) continue;
            seen.add(slug);
            current.slugs.push(slug);
        }
    }
    return sections.filter((section) => section.slugs.length > 0);
}

/**
 * Every page in the order the sidebar lists it: the given sections first, then
 * a last one with any page none of them names, so a new guide always shows up.
 */
export function arrangeSections(
    sections: readonly DocSection[],
    slugs: readonly string[],
    moreLabel: string
): DocSection[] {
    const known = new Set(slugs);
    const placed = new Set<string>();
    const out: DocSection[] = [];
    for (const section of sections) {
        const kept = section.slugs.filter((slug) => known.has(slug) && !placed.has(slug));
        kept.forEach((slug) => placed.add(slug));
        if (kept.length) out.push({ label: section.label, slugs: kept });
    }
    const rest = slugs.filter((slug) => !placed.has(slug));
    if (rest.length) out.push({ label: moreLabel, slugs: rest });
    return out;
}

/** The pages before and after one, across section boundaries. */
export function docNeighbors(
    sections: readonly DocSection[],
    slug: string
): { previous: string | null; next: string | null; section: string | null } {
    const order = sections.flatMap((section) => section.slugs);
    const at = order.indexOf(slug);
    const section = sections.find((one) => one.slugs.includes(slug))?.label ?? null;
    if (at < 0) return { previous: null, next: null, section };
    return { previous: order[at - 1] ?? null, next: order[at + 1] ?? null, section };
}

/**
 * The README's list of connected services as a guide of its own: the section
 * whose table carries the logos, each row a heading named after its services
 * so a search for one lands on it. Nothing is added that the README does not say.
 */
export function integrationsGuide(readme: string): { title: string; markdown: string } | null {
    const lines = readme.replace(/\r\n/g, "\n").split("\n");
    for (let at = 0; at < lines.length; at++) {
        const heading = /^## (.+)$/.exec(lines[at]!);
        if (!heading) continue;
        let end = lines.findIndex((line, n) => n > at && /^## /.test(line));
        if (end < 0) end = lines.length;
        const body = lines.slice(at + 1, end);
        if (!body.some((line) => /^\|.*docs\/assets\/logos\//.test(line))) continue;
        const out: string[] = [];
        for (const line of body) {
            if (!line.startsWith("|")) {
                out.push(line);
                continue;
            }
            const cells = line
                .split("|")
                .slice(1, -1)
                .map((cell) => cell.trim());
            const logos = cells[0] ?? "";
            const names = [...logos.matchAll(/alt="([^"]+)"/g)].map((match) => match[1]!);
            if (!names.length) continue;
            const pictures = [...logos.matchAll(/<img [^>]*>/g)].map((match) => match[0]).join(" ");
            out.push(
                "",
                `## ${names.join(", ")}`,
                "",
                `<p class="doc-logos">${pictures}</p>`,
                "",
                cells.slice(1).join(" "),
                ""
            );
        }
        return {
            title: heading[1]!.trim(),
            markdown: out
                .join("\n")
                .replace(/\n{3,}/g, "\n\n")
                .trim()
        };
    }
    return null;
}

type Schema = Record<string, unknown>;

/** A plausible value for a JSON Schema, so a request example has a body to send. */
export function exampleFromSchema(schema: unknown, depth = 0): unknown {
    if (!schema || typeof schema !== "object" || depth > 6) return null;
    const s = schema as Schema;
    if ("example" in s) return s.example;
    if ("default" in s) return s.default;
    if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
    if ("const" in s) return s.const;
    for (const key of ["oneOf", "anyOf", "allOf"] as const)
        if (Array.isArray(s[key]) && (s[key] as unknown[]).length)
            return exampleFromSchema((s[key] as unknown[])[0], depth + 1);
    const type = Array.isArray(s.type) ? s.type.find((t) => t !== "null") : s.type;
    switch (type) {
        case "object": {
            const props = (s.properties ?? {}) as Record<string, unknown>;
            return Object.fromEntries(
                Object.entries(props).map(([key, value]) => [
                    key,
                    exampleFromSchema(value, depth + 1)
                ])
            );
        }
        case "array":
            return [exampleFromSchema(s.items, depth + 1)].filter((item) => item !== null);
        case "integer":
        case "number":
            return typeof s.minimum === "number" ? s.minimum : 0;
        case "boolean":
            return false;
        case "string":
            if (s.format === "date-time") return "2026-01-01T00:00:00.000Z";
            if (s.format === "uri" || s.format === "url") return "https://example.com";
            if (s.format === "email") return "someone@example.com";
            return "string";
        default:
            return null;
    }
}

export interface RequestSample {
    readonly label: string;
    readonly lang: "bash" | "javascript" | "python";
    readonly code: string;
}

/** The same call in curl, JavaScript and Python, against a placeholder address and key. */
export function requestSamples(
    op: Pick<ApiOperation, "method" | "path" | "body">,
    origin: string
): RequestSample[] {
    const url = `${origin}${op.path}`;
    const body = op.body ? JSON.stringify(exampleFromSchema(JSON.parse(op.body)), null, 2) : null;
    const indent = (text: string, pad: string) => text.split("\n").join(`\n${pad}`);
    const curl = [
        `curl -X ${op.method} "${url}" \\`,
        `  -H "Authorization: Bearer $POLARIS_API_KEY"${body ? " \\" : ""}`,
        ...(body
            ? [`  -H "Content-Type: application/json" \\`, `  -d '${body.replace(/'/g, "'\\''")}'`]
            : [])
    ].join("\n");
    const js = [
        `const response = await fetch("${url}", {`,
        `    method: "${op.method}",`,
        "    headers: {",
        `        Authorization: \`Bearer \${process.env.POLARIS_API_KEY}\`${body ? "," : ""}`,
        ...(body ? [`        "Content-Type": "application/json"`] : []),
        `    }${body ? "," : ""}`,
        ...(body ? [`    body: JSON.stringify(${indent(body, "    ")})`] : []),
        "});",
        "console.log(await response.json());"
    ].join("\n");
    const pyBody = body
        ?.replace(/\btrue\b/g, "True")
        .replace(/\bfalse\b/g, "False")
        .replace(/\bnull\b/g, "None");
    const py = [
        "import os",
        "import requests",
        "",
        "response = requests.request(",
        `    "${op.method}",`,
        `    "${url}",`,
        `    headers={"Authorization": f"Bearer {os.environ['POLARIS_API_KEY']}"},`,
        ...(pyBody ? [`    json=${indent(pyBody, "    ")},`] : []),
        ")",
        "print(response.json())"
    ].join("\n");
    return [
        { label: "curl", lang: "bash", code: curl },
        { label: "JavaScript", lang: "javascript", code: js },
        { label: "Python", lang: "python", code: py }
    ];
}
