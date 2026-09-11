/**
 * Making a document, and getting rid of one.
 *
 * **Making one was a form.** It asked for a name and a shelf, which are two
 * questions nobody has an answer to before the document exists: the name is
 * decided by what ends up in it, and the shelf is the one they are already
 * working on. Every other editor makes an untitled document and opens it, with
 * the title as a field at the top that somebody fills in when they have
 * something to say.
 *
 * **And deleting one asked nothing at all.** Both of them: the bin icon on a
 * row took the document somebody was working on with one press of a button that
 * sits a few pixels from the star, and emptying the bin past that point - which
 * is the end of the document - went the same way. Two different questions are
 * owed there: "into the bin?", which is answered plainly because it is undone
 * from the bin, and "for good?", which names what it is destroying.
 *
 * **And neither moved the screen until the server answered.** Every button on
 * every row was disabled for the round trip and then the whole list was fetched
 * again, so the case that works - all of them - is the one that reads as
 * broken.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { normalizeOfficeTitle, officeCreateSchema } from "@polaris/core";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

describe("what a new document is called", () => {
    it("is untitled until somebody says otherwise", () => {
        expect(normalizeOfficeTitle("", "sheet")).toMatch(/untitled/i);
        expect(normalizeOfficeTitle("  ", "doc")).toMatch(/untitled/i);
    });

    it("is what they typed the moment they type one", () => {
        expect(normalizeOfficeTitle("Q3 numbers", "sheet")).toBe("Q3 numbers");
    });
});

describe("which shelf it lands on", () => {
    it("has three answers, not two", () => {
        // An id is that organization, null is explicitly somebody's own, and
        // leaving it out is the shelf they are working on.
        expect(officeCreateSchema.parse({ kind: "sheet" }).orgId).toBeUndefined();
        expect(officeCreateSchema.parse({ kind: "sheet", orgId: null }).orgId).toBeNull();
    });

    it("is resolved to where they are working when it was not asked for", async () => {
        const actions = await readFile(`${SRC}app/(app)/office/actions.ts`, "utf8");
        expect(actions).toContain(
            "parsed.data.orgId === undefined ? await scopeOrgIdFor(user.id) : parsed.data.orgId"
        );
    });

    it("is written as a value rather than an absence", async () => {
        const store = await readFile(`${SRC}lib/office/documents.ts`, "utf8");
        expect(store).toContain("orgId: input.orgId ?? null");
    });
});

describe("pressing New", () => {
    const view = readFile(`${SRC}app/(app)/office/office-view.tsx`, "utf8");

    it("makes the document and opens it", async () => {
        const source = await view;
        expect(source).toContain("const answer = await createDocumentAction({ kind });");
        expect(source).toContain("router.push(core.officeDocumentPath(kind, answer.id));");
    });

    it("asks nothing on the way", async () => {
        const source = await view;
        expect(source).not.toContain("NewDialog");
        expect(source).not.toContain("Who it belongs to");
    });

    it("does not make two when it is pressed twice", async () => {
        const source = await view;
        expect(source).toContain("if (making) return;");
    });
});

describe("putting one in the bin", () => {
    const view = readFile(`${SRC}app/(app)/office/office-view.tsx`, "utf8");

    it("asks, and names the document it is about to take", async () => {
        const source = await view;
        expect(source).toContain("title: `Move ${row.title} to the bin?`");
        expect(source).toContain('confirmLabel: "Move to the bin"');
        expect(source).toContain("if (!sure) return;");
    });

    it("says where it goes and that it can come back", async () => {
        const source = await view;
        expect(source).toContain("waits in the bin, where you can put it back");
    });

    it("does not ask to put one back, which loses nothing", async () => {
        const source = await view;
        const ask = source.slice(source.indexOf("const bin = useCallback"));
        expect(ask.slice(0, ask.indexOf("await act("))).toContain("if (!row.trashed) {");
    });

    it("takes the row off the list on that answer, not the server's", async () => {
        const source = await view;
        expect(source).toContain("onTrash={() => void bin(row)}");
        expect(source).toContain("drop(row.id),");
    });
});

describe("deleting one for good", () => {
    const view = readFile(`${SRC}app/(app)/office/office-view.tsx`, "utf8");

    it("asks first, and names what it is deleting", async () => {
        const source = await view;
        expect(source).toContain("<ConfirmDeleteDialog");
        expect(source).toContain("onDelete={() => setBurning({ id: row.id, title: row.title })}");
        expect(source).toContain("Nothing here can bring it back.");
    });

    it("asks it plainly: one row of a bin somebody empties a few at a time", async () => {
        const source = await view;
        expect(source).toContain("requireTyping={false}");
    });

    it("is the schema's own default that says an untitled document is allowed", async () => {
        const office = await readFile(`${ROOT}packages/core/src/office.ts`, "utf8");
        expect(office).toContain('title: z.string().trim().max(MAX_OFFICE_TITLE).default("")');
    });
});

describe("what the list does while the server is being told", () => {
    const view = readFile(`${SRC}app/(app)/office/office-view.tsx`, "utf8");

    it("moves the row first and puts the list back if the write is refused", async () => {
        const source = await view;
        const act = source.slice(source.indexOf("const act = useCallback"));
        const body = act.slice(0, act.indexOf("[documents, load, toast]"));
        expect(body).toContain("const before = documents;");
        expect(body.indexOf("setDocuments((rows) =>")).toBeLessThan(body.indexOf("await run()"));
        expect(body).toContain("setDocuments(before);");
    });

    it("stops disabling every button on every row for the round trip", async () => {
        const source = await view;
        expect(source).not.toContain("const [busy, setBusy] = useState(false);");
        expect(source).not.toContain("busy={busy}");
    });

    it("keeps a starred row in place, except on the shelf it just left", async () => {
        const source = await view;
        expect(source).toContain("starredOnly");
        expect(source).toContain("{ ...one, starred: !row.starred }");
    });
});

describe("taking somebody's access back", () => {
    const dialog = readFile(`${SRC}components/access/share-dialog.tsx`, "utf8");

    it("asks before the person loses it, and says who", async () => {
        const source = await dialog;
        expect(source).toContain("title: `Stop sharing with ${grant.principalName}?`");
        expect(source).toContain('confirmLabel: "Stop sharing"');
    });

    it("drops the row on that answer and restores it on a refusal", async () => {
        const source = await dialog;
        expect(source).toContain("const before = grants;");
        expect(source).toContain("setGrants(before);");
    });
});
