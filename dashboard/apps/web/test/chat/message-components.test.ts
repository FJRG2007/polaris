/**
 * The buttons and forms under a message Polar or an app wrote: what may be
 * stored, what is read back, and what a form's answers must be.
 */

import { describe, expect, it } from "vitest";
import { appCommandIn } from "@/lib/chat/chat-command";
import {
    componentLook,
    formAnswersSchema,
    readComponents,
    selectValuesSchema,
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
describe("button styles, as Discord's", () => {
    it("maps each style onto the design system's buttons", () => {
        const look = (style: string) =>
            componentLook(readComponents([{ type: "button", label: "Go", action: "polar.retry", style }])[0]!);
        expect(look("primary")).toEqual({ variant: "primary" });
        expect(look("secondary")).toEqual({ variant: "secondary" });
        expect(look("danger")).toEqual({ variant: "danger" });
        // Green from the success tokens, never a colour of its own.
        expect(look("success").className).toContain("bg-success");
        expect(look("success").className).toContain("text-success-foreground");
        expect(componentLook(readComponents([{ type: "link", label: "Open", href: "/tasks" }])[0]!)).toEqual({
            variant: "secondary"
        });
    });

    it("reads a style or an icon a newer version added as the plain button, not as no button", () => {
        const [button] = readComponents([
            { type: "button", label: "Go", action: "polar.retry", style: "premium", icon: "sparkles" }
        ]);
        expect(button).toMatchObject({ type: "button", style: "secondary" });
        expect(button && "icon" in button ? button.icon : undefined).toBeUndefined();
    });

    it("keeps disabled and a known icon", () => {
        const [button] = readComponents([
            { type: "button", label: "Delete", action: "polar.retry", style: "danger", icon: "trash", disabled: true }
        ]);
        expect(button).toMatchObject({ style: "danger", icon: "trash", disabled: true });
    });

    it("still reads rows stored before styles grew", () => {
        const old = [
            { type: "button", label: "Try again", style: "secondary", action: "polar.retry", for: "u1" },
            {
                type: "form",
                label: "New task",
                style: "primary",
                action: "tasks.create",
                title: "New task",
                submit: "Create",
                fields: [{ name: "name", label: "Title", kind: "text", required: true, max: 200 }]
            },
            { type: "link", label: "Open task", href: "/tasks/t/1" }
        ];
        expect(readComponents(old).map((one) => one.type)).toEqual(["button", "form", "link"]);
    });
});

describe("a select menu", () => {
    const options = [
        { value: "a", label: "A" },
        { value: "b", label: "B", description: "The second one" },
        { value: "c", label: "C", default: true }
    ];

    it("is stored with its options, a single choice by default", () => {
        const [select] = storedComponents([{ type: "select", action: "tasks.pick", options }]);
        expect(select).toMatchObject({ type: "select", min: 1, max: 1 });
    });

    it("is refused when it cannot be answered", () => {
        expect(() => storedComponents([{ type: "select", action: "tasks.pick", options, min: 3, max: 2 }])).toThrow();
        expect(() => storedComponents([{ type: "select", action: "tasks.pick", options, max: 4 }])).toThrow();
        expect(() =>
            storedComponents([
                { type: "select", action: "tasks.pick", options: [...options, { value: "a", label: "Again" }] }
            ])
        ).toThrow();
        expect(() => storedComponents([{ type: "select", action: "tasks.pick", options: [] }])).toThrow();
        // Read back, one that is not well formed is dropped rather than drawn.
        expect(readComponents([{ type: "select", action: "tasks.pick", options, min: 3, max: 2 }])).toEqual([]);
    });

    it("takes only offered values, within min and max, each once", () => {
        const [select] = storedComponents([{ type: "select", action: "tasks.pick", options, min: 1, max: 2 }]);
        if (select?.type !== "select") throw new Error("not a select");
        const schema = selectValuesSchema(select);
        expect(schema.parse(["a", "c"])).toEqual(["a", "c"]);
        for (const values of [[], ["a", "b", "c"], ["a", "a"], ["z"], [1]]) {
            expect(schema.safeParse(values).success).toBe(false);
        }
    });
});
