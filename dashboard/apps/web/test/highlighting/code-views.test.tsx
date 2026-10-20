// @vitest-environment jsdom

/**
 * Every place that shows code paints it with the shared highlighter: the API
 * reference (an HTTP header, JSON bodies, a curl command), Polar's tool calls,
 * and the generic `CodeView` the sweep added for grammars other than JSON.
 * Prose - a tool's own sentence - stays unpainted.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
    default: ({ children, href }: { children: unknown; href: string }) => (
        <a href={href}>{children as never}</a>
    )
}));

const { MessagesWrapper } = await import("../setup/i18n");
const { CodeEditor, CodeView } = await import("@/components/json-view");
const { ToolInput, ToolOutput } = await import("@/components/polar/elements/tool");
const { ApiReferenceView } = await import(
    "@/app/(app)/account/api-keys/reference/api-reference-view"
);

afterEach(cleanup);

/** Waits for highlight.js to have painted something inside `root`. */
async function painted(root: HTMLElement, cls = "[class^='hljs-']") {
    await vi.waitFor(() => expect(root.querySelector(cls)).not.toBeNull(), { timeout: 4000 });
}

describe("CodeView", () => {
    it("paints a shell command with the bash grammar", async () => {
        const { container } = render(
            <MessagesWrapper>
                <CodeView
                    value={'curl -H "Accept: x" https://x.test'}
                    language="bash"
                    label="cmd"
                />
            </MessagesWrapper>
        );
        await painted(container);
        expect(container.textContent).toContain("curl");
    });
});

describe("CodeEditor", () => {
    it("paints a command as it is typed and keeps the field's label and state", async () => {
        const typed: string[] = [];
        const { container } = render(
            <MessagesWrapper>
                <label htmlFor="cmd">Command</label>
                <CodeEditor
                    id="cmd"
                    value="echo $HOME"
                    language="bash"
                    invalid
                    onChange={(next) => typed.push(next)}
                />
            </MessagesWrapper>
        );
        await painted(container);
        const field = screen.getByLabelText("Command");
        expect(field.getAttribute("aria-invalid")).toBe("true");
        fireEvent.change(field, { target: { value: "ls" } });
        expect(typed).toEqual(["ls"]);
    });
});

describe("Polar's tool call", () => {
    it("paints the input and a data result as JSON", async () => {
        const { container } = render(
            <MessagesWrapper>
                <ToolInput input={{ deviceId: "d1" }} />
                <ToolOutput output={{ rows: [1, 2] }} />
            </MessagesWrapper>
        );
        await painted(container);
        expect(container.querySelectorAll("pre").length).toBe(2);
        expect(container.textContent).toContain('"rows"');
    });

    it("leaves a tool's sentence as prose", () => {
        const { container } = render(
            <MessagesWrapper>
                <ToolOutput output={{ ok: true, text: "Done." }} />
            </MessagesWrapper>
        );
        expect(container.querySelector("[class^='hljs-']")).toBeNull();
        expect(container.textContent).toContain("Done.");
    });
});

describe("the API reference", () => {
    it("paints the header, the bodies and the curl example", async () => {
        const { container } = render(
            <MessagesWrapper>
                <ApiReferenceView
                    placeholder="pk_test"
                    entries={[
                        {
                            id: "things-make",
                            method: "POST",
                            path: "/api/v1/things",
                            tag: "things",
                            summary: "Make a thing",
                            description: null,
                            changes: true,
                            parameters: [],
                            body: '{"type":"object"}',
                            bodyExample: null,
                            binaryType: null,
                            responses: [
                                {
                                    status: 200,
                                    description: "Made",
                                    schema: '{"type":"object"}',
                                    text: false
                                }
                            ]
                        } as never
                    ]}
                />
            </MessagesWrapper>
        );
        await painted(container);
        // Nothing in the reference is left as an unpainted block.
        for (const block of container.querySelectorAll("pre")) {
            await vi.waitFor(() => expect(block.querySelector("[class^='hljs-']")).not.toBeNull(), {
                timeout: 4000
            });
        }
    });
});
