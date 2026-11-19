/**
 * The buttons and forms under a message Polar or an app wrote: what may be
 * stored, what is read back, and what a form's answers must be.
 */

import { describe, expect, it } from "vitest";
import { appCommandIn } from "@/lib/chat/chat-command";
import {
    formAnswersSchema,
    readComponents,
    storedComponents,
    type FormField
} from "@/lib/chat/message-components";

describe("a link under a message", () => {
    it("goes only somewhere on this dashboard", () => {
        expect(() => storedComponents([{ type: "link", label: "Set up", href: "/polar/settings/providers" }])).not.toThrow();
        for (const href of ["https://evil.test", "//evil.test", "/\\evil.test", "javascript:alert(1)", "polar"]) {
            expect(() => storedComponents([{ type: "link", label: "Go", href }])).toThrow();
        }
    });
});

describe("components read back from a row", () => {
    it("keeps what parses and drops the rest, never failing the conversation", () => {
        const read = readComponents([
            { type: "button", label: "Try again", action: "polar.retry" },
            { type: "carousel", label: "From a newer version" },
            { type: "link", label: "Out", href: "https://elsewhere.test" },
            "nonsense"
        ]);
        expect(read).toEqual([{ type: "button", label: "Try again", style: "secondary", action: "polar.retry" }]);
        expect(readComponents(null)).toEqual([]);
        expect(readComponents({ not: "a list" })).toEqual([]);
    });

    it("reads at most five", () => {
        const many = Array.from({ length: 8 }, (_, at) => ({ type: "button", label: `B${at}`, action: "polar.retry" }));
        expect(readComponents(many)).toHaveLength(5);
        expect(() => storedComponents(many as never)).toThrow();
    });
});

describe("a form's answers", () => {
    const fields: FormField[] = [
        { name: "name", label: "Title", kind: "text", required: true, max: 10 },
        {
            name: "list",
            label: "List",
            kind: "choice",
            required: true,
            max: 200,
            options: [{ value: "l1", label: "Work / Inbox" }]
        },
        { name: "description", label: "Description", kind: "long", required: false, max: 50 }
    ];
    const schema = formAnswersSchema(fields);

    it("takes a filled form, trimmed, with an empty optional field", () => {
        expect(schema.parse({ name: "  Milk ", list: "l1" })).toEqual({ name: "Milk", list: "l1", description: "" });
    });

    it("refuses a required field left empty, a choice it did not offer, and text past its length", () => {
        expect(schema.safeParse({ name: "   ", list: "l1" }).success).toBe(false);
        expect(schema.safeParse({ name: "Milk", list: "somebody-elses-list" }).success).toBe(false);
        expect(schema.safeParse({ name: "far too long a title", list: "l1" }).success).toBe(false);
    });
});

describe("a message that runs an app command", () => {
    it("is the command, then what was written after it", () => {
        expect(appCommandIn("/polar how do I squash?")).toEqual({ name: "polar", text: "how do I squash?" });
        expect(appCommandIn("/Task  Buy milk\nand eggs")).toEqual({ name: "task", text: "Buy milk\nand eggs" });
        expect(appCommandIn("/task")).toEqual({ name: "task", text: "" });
    });

    it("is not a command nobody answers, a word that only starts like one, or a slash mid-sentence", () => {
        expect(appCommandIn("/online")).toBeNull();
        expect(appCommandIn("/polarbear hi")).toBeNull();
        expect(appCommandIn("ask /polar later")).toBeNull();
    });
});
