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
 * **And deleting one for good asked nothing at all.** The bin is where a
 * document waits; emptying it past that point is the end of it, and it went on
 * one click with no question and no way back.
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

describe("deleting one for good", () => {
    it("asks first, and names what it is deleting", async () => {
        const view = await readFile(`${SRC}app/(app)/office/office-view.tsx`, "utf8");
        expect(view).toContain("<ConfirmDeleteDialog");
        expect(view).toContain("onDelete={() => setBurning({ id: row.id, title: row.title })}");
        expect(view).toContain("Nothing here can bring it back.");
    });

    it("leaves the bin itself one press away, which is the reversible one", async () => {
        // Moving to the bin asks nothing on purpose: it is undone by the button
        // next to it.
        const view = await readFile(`${SRC}app/(app)/office/office-view.tsx`, "utf8");
        expect(view).toContain("trashDocumentAction(row.id, !row.trashed)");
    });

    it("is the schema's own default that says an untitled document is allowed", async () => {
        const office = await readFile(`${ROOT}packages/core/src/office.ts`, "utf8");
        expect(office).toContain('title: z.string().trim().max(MAX_OFFICE_TITLE).default("")');
    });
});
