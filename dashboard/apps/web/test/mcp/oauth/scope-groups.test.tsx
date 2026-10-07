// @vitest-environment jsdom
/**
 * The consent list's sections, driven by clicks: a section's own box ticks
 * every scope in it except a sensitive one, and clears them again; a folded
 * section opens on its heading.
 */

import { withMessages } from "../../setup/i18n";
import { McpScopeChecklist } from "@/components/mcp-scope-checklist";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(cleanup);

describe("a section of the consent list", () => {
    it("ticks what is not sensitive, and leaves sending mail to its own box", () => {
        const toggle = vi.fn();
        render(
            withMessages(
                <McpScopeChecklist
                    offered={["mail.read", "mail.send"]}
                    selected={[]}
                    effective={new Set()}
                    onToggle={toggle}
                />
            )
        );
        fireEvent.click(screen.getByLabelText("Allow everything in Mail"));
        expect(toggle.mock.calls).toEqual([["mail.read", true]]);
    });

    it("clears what it ticked, and leaves a ticked sensitive scope alone", () => {
        const toggle = vi.fn();
        render(
            withMessages(
                <McpScopeChecklist
                    offered={["mail.read", "mail.send"]}
                    selected={["mail.read", "mail.send"]}
                    effective={new Set(["mail.read", "mail.send"])}
                    onToggle={toggle}
                />
            )
        );
        fireEvent.click(screen.getByLabelText("Allow everything in Mail"));
        expect(toggle.mock.calls).toEqual([["mail.read", false]]);
    });

    it("starts folded past two sections and opens on its heading", () => {
        render(
            withMessages(
                <McpScopeChecklist
                    offered={["tasks.read", "mail.read", "places.read"]}
                    selected={[]}
                    effective={new Set()}
                    onToggle={vi.fn()}
                />
            )
        );
        expect(screen.queryByText("Read and search your mail")).toBeNull();
        fireEvent.click(screen.getByLabelText("Show Mail"));
        expect(screen.getByText("Read and search your mail")).toBeTruthy();
    });

    it("opens what a permission allows under its box, by what it reads and what it changes", () => {
        const toggle = vi.fn();
        render(
            withMessages(
                <McpScopeChecklist
                    offered={["tasks.read", "tasks.manage"]}
                    selected={[]}
                    effective={new Set()}
                    abilities={{
                        "tasks.manage": [
                            {
                                name: "tasks_reminders",
                                label: "List task reminders",
                                readOnly: true
                            },
                            {
                                name: "tasks_remind",
                                label: "Remind me about a task",
                                readOnly: false
                            }
                        ]
                    }}
                    onToggle={toggle}
                />
            )
        );
        const info = screen.getByLabelText("What it allows: Create and change tasks");
        expect(info.getAttribute("aria-expanded")).toBe("false");
        expect(screen.queryByText("Remind me about a task")).toBeNull();
        fireEvent.click(info);
        expect(info.getAttribute("aria-expanded")).toBe("true");
        expect(screen.getByText("Can look at")).toBeTruthy();
        expect(screen.getByText("List task reminders")).toBeTruthy();
        expect(screen.getByText("Can change")).toBeTruthy();
        expect(screen.getByText("Remind me about a task")).toBeTruthy();
        expect(screen.getByText("Also includes: Read spaces, lists and tasks")).toBeTruthy();
        // Opening the list is not ticking the box.
        expect(toggle).not.toHaveBeenCalled();
        fireEvent.click(info);
        expect(screen.queryByText("Remind me about a task")).toBeNull();
    });

    it("says so when nothing uses a permission, and has no button without abilities", () => {
        const { unmount } = render(
            withMessages(
                <McpScopeChecklist
                    offered={["notes.use"]}
                    selected={[]}
                    effective={new Set()}
                    abilities={{}}
                    onToggle={vi.fn()}
                />
            )
        );
        fireEvent.click(screen.getByLabelText("What it allows: Read and write your notes"));
        expect(screen.getByText("Nothing on this Polaris uses it yet.")).toBeTruthy();
        unmount();
        render(
            withMessages(
                <McpScopeChecklist
                    offered={["notes.use"]}
                    selected={[]}
                    effective={new Set()}
                    onToggle={vi.fn()}
                />
            )
        );
        expect(screen.queryByLabelText("What it allows: Read and write your notes")).toBeNull();
    });
});
