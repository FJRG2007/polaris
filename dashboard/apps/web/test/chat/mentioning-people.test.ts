/**
 * Finding somebody with `@`.
 *
 * Three names can lead to one person and the picker matched one of them. It
 * searched the display name and the e-mail address - so the handle it drew under
 * every result was not something you could type to get there, and the name the
 * reader themself gave somebody was not either.
 *
 * The nickname is the interesting one. It is private to whoever set it, lives in
 * its own table keyed by who gave it, and is the name that reader actually
 * thinks in - so it cannot be a clause on the user query, and leaving it out
 * meant typing the only name you know for somebody found nobody.
 *
 * What must not happen is a nickname widening reach. Naming a person is not
 * permission to mention them, so the scope the search already had is applied to
 * the nickname hits too.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const service = readFile(`${SRC}lib/rich-text/mention-service.ts`, "utf8");

/** The body of the people search, which is where all of this lives. */
async function searchPeople(): Promise<string> {
    const source = await service;
    const from = source.indexOf("async function searchPeople");
    return source.slice(from, source.indexOf("\n}", from));
}

describe("what a name can be typed as", () => {
    it("matches the handle it has been drawing all along", async () => {
        // The username was selected, shown under every result, and matched by
        // nothing: typing it found somebody only when it happened to be part of
        // their display name.
        expect(await searchPeople()).toContain("{ username: contains }");
    });

    it("still matches the display name and the address", async () => {
        const body = await searchPeople();
        expect(body).toContain("{ name: contains }");
        expect(body).toContain("{ email: contains }");
    });

    it("matches the name this reader gave them", async () => {
        const body = await searchPeople();
        // Its own table, keyed by who gave it - so it is looked up first and
        // joined on by id rather than being a clause on the user query.
        expect(body).toContain("prisma.contactName.findMany");
        expect(body).toContain("where: { ownerId: actor.id, nickname: contains }");
        expect(body).toContain("{ id: { in: named.map((row) => row.subjectId) } }");
    });
});

describe("what a nickname does not do", () => {
    it("does not widen who can be mentioned", async () => {
        const body = await searchPeople();
        // The scope clause sits on the same query the nickname ids are joined
        // into, so a name you gave somebody out of reach still finds nobody.
        expect(body).toContain("...(scope ? { id: { in: scope } } : {})");
    });

    it("is not looked up for a search with nothing in it", async () => {
        const body = await searchPeople();
        expect(body).toContain("const named = contains");
    });
});

describe("what the row says", () => {
    it("leads with the name the reader thinks in", async () => {
        const body = await searchPeople();
        expect(body).toContain("label: nickname || real");
    });

    it("keeps the real name underneath it", async () => {
        // A mention names somebody to a room that does not share the nickname,
        // so what everybody else will read has to be on screen too.
        const body = await searchPeople();
        expect(body).toContain("detail: nickname ? under :");
    });

    it("reuses the loader the rest of the chat uses", async () => {
        const source = await service;
        expect(source).toContain('import { nicknamesFor } from "@/lib/contact-names";');
    });
});
