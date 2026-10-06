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
});
