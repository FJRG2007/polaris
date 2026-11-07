import { describe, expect, it } from "vitest";
import { searchRecords, type SiteData } from "../../src/data/builders";
import enTvCompat from "../../../web/messages/en-US/tvCompat.json" with { type: "json" };
import esTvCompat from "../../../web/messages/es-ES/tvCompat.json" with { type: "json" };
import {
    chunkIndex,
    joinIndex,
    parseRecent,
    rememberRecent,
    searchIndex,
    snippet,
    type SearchRecord
} from "../../src/lib/search-index";

const page = (slug: string, title: string, headings: [string, string, string][]) => ({
    slug,
    source: `docs/features/${slug}.md`,
    title,
    summary: "",
    html: "",
    headings: headings.map(([id, text]) => ({ id, text })),
    text: Object.fromEntries([
        ["", `${title} intro`],
        ...headings.map(([id, , body]) => [id, body])
    ])
});

const data = {
    docs: {
        en: [
            page("drive", "Drive", [
                ["sharing", "Sharing", "Send a link with a password and an expiry date."],
                ["versions", "Versions", "Every save keeps the previous file."]
            ]),
            page("mail", "Mail", [["filters", "Filters", "Sort incoming messages into folders."]])
        ],
        es: [
            page("drive", "Drive", [["compartir", "Compartir", "Envía un enlace con contraseña."]])
        ]
    },
    api: {
        groups: [
            {
                tag: "Tasks",
                operations: [
                    {
                        id: "listTasks",
                        method: "GET",
                        path: "/api/v1/tasks",
                        summary: "List tasks",
                        description: ""
                    }
                ]
            }
        ]
    }
} as unknown as Pick<SiteData, "docs" | "api">;

const en = searchRecords(data, "en", "API reference");

describe("the docs search index", () => {
    it("has a record per page, per heading and per API operation, without the base path", () => {
        expect(en.map((record) => record.href)).toEqual([
            "en/docs/drive/",
            "en/docs/drive/#sharing",
            "en/docs/drive/#versions",
            "en/docs/mail/",
            "en/docs/mail/#filters",
            "en/docs/api/#listTasks"
        ]);
        expect(en[1]).toMatchObject({ title: "Sharing", page: "Drive" });
    });

    it("builds each locale from its own guides", () => {
        const es = searchRecords(data, "es", "Referencia");
        expect(es.map((record) => record.title)).toEqual(["Drive", "Compartir", "List tasks"]);
        expect(es.every((record) => record.href.startsWith("es/"))).toBe(true);
    });

    it("finds a heading, a word in a section's body, and the start of a word", () => {
        expect(searchIndex(en, "sharing")[0]!.records[0]!.href).toBe("en/docs/drive/#sharing");
        expect(searchIndex(en, "expiry")[0]!.records[0]!.href).toBe("en/docs/drive/#sharing");
        expect(searchIndex(en, "fold")[0]!.records[0]!.href).toBe("en/docs/mail/#filters");
    });

    it("forgives a typo in a title", () => {
        expect(searchIndex(en, "verisons")[0]!.records[0]!.title).toBe("Versions");
    });

    it("answers nothing for a word no page has, and for an empty query", () => {
        expect(searchIndex(en, "zebra")).toEqual([]);
        expect(searchIndex(en, "  ")).toEqual([]);
    });

    it("groups results under their page, best page first", () => {
        const groups = searchIndex(en, "tasks");
        expect(groups[0]!.page).toBe("API reference");
    });

    it("splits the texts into chunks and puts them back where they were", () => {
        const { manifest, chunks } = chunkIndex(en, 60);
        expect(chunks.length).toBeGreaterThan(1);
        expect(manifest.chunks).toHaveLength(chunks.length);
        expect(manifest.records.every((record) => !("text" in record))).toBe(true);
        const titlesOnly = joinIndex(manifest, new Map());
        expect(titlesOnly.every((record) => record.text === "")).toBe(true);
        const all = joinIndex(manifest, new Map(chunks.map((chunk, at) => [at, chunk])));
        expect(all).toEqual(en);
    });

    it("cuts a long section around its first match", () => {
        const text = `${"a ".repeat(200)}needle ${"b ".repeat(200)}`;
        const cut = snippet(text, ["needle"]);
        expect(cut).toContain("needle");
        expect(cut.startsWith("... ")).toBe(true);
        expect(cut.length).toBeLessThan(160);
    });
});

describe("recent searches", () => {
    const entry = (n: number): SearchRecord => ({
        title: `T${n}`,
        page: "P",
        href: `en/docs/p/#t${n}`,
        text: ""
    });

    it("keeps the newest first, once each, eight at most", () => {
        let list = rememberRecent([], entry(1));
        for (let n = 2; n <= 10; n++) list = rememberRecent(list, entry(n));
        list = rememberRecent(list, entry(5));
        expect(list).toHaveLength(8);
        expect(list[0]!.href).toBe("en/docs/p/#t5");
        expect(list.filter((one) => one.href === "en/docs/p/#t5")).toHaveLength(1);
    });

    it("reads back only well-formed entries that stay on this site", () => {
        expect(parseRecent("not json")).toEqual([]);
        expect(parseRecent(null)).toEqual([]);
        expect(
            parseRecent(
                JSON.stringify([
                    { title: "ok", page: "P", href: "en/docs/drive/" },
                    { title: "away", page: "P", href: "https://example.invalid/" },
                    { title: "bad" }
                ])
            ).map((one) => one.title)
        ).toEqual(["ok"]);
    });
});

describe("the TV models in the docs search", () => {
    const tv = {
        ...data,
        docs: {
            en: [
                page("polaris-tv-compatibility", "Does it work on my TV?", []),
                page("polaris-tv-privacy", "Privacy switches", [])
            ],
            es: []
        },
        downloadsPage: {
            messages: { en: { tvCompat: enTvCompat }, es: { tvCompat: esTvCompat } }
        }
    } as unknown as Pick<SiteData, "docs" | "api" | "downloadsPage">;
    const records = searchRecords(tv, "en", "API reference");

    it("sends a model number to the checker with the model filled in", () => {
        const hit = searchIndex(records, "TCL 32ES570F")[0]!.records[0]!;
        expect(hit.page).toBe("Does it work on my TV?");
        expect(hit.href).toMatch(/^en\/docs\/polaris-tv-compatibility\/\?q=TCL%2032ES570F/);
    });

    it("sends a brand's privacy switches to its section", () => {
        const hit = searchIndex(records, "Viewing Information Services")[0]!.records[0]!;
        expect(hit.href).toBe("en/docs/polaris-tv-privacy/#samsung");
    });

    it("searches a brand's privacy switches in the reader's language", () => {
        const es = {
            ...tv,
            docs: { en: [], es: [page("polaris-tv-privacy", "Interruptores de privacidad", [])] }
        } as unknown as Pick<SiteData, "docs" | "api" | "downloadsPage">;
        const hit = searchIndex(searchRecords(es, "es", "Referencia"), "retira el consentimiento");
        expect(hit[0]!.records[0]!.href).toBe("es/docs/polaris-tv-privacy/#tcl");
    });

    it("adds no TV records to a locale without the checker page", () => {
        expect(searchRecords(tv, "es", "Referencia").every((r) => !r.href.includes("?q="))).toBe(
            true
        );
    });
});
