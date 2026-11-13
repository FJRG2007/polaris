// @vitest-environment jsdom
/**
 * The "/" list over a Code composer: it opens on a "/" at the start, narrows as
 * you type, walks with the arrows, runs on Enter, completes on Tab, closes on
 * Escape, and is drawn in a portal rather than inside the composer.
 */

import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MessagesWrapper } from "../setup/i18n";
import { useCodeSlash } from "@/components/polar/polar-code-slash";
import * as codeCommands from "@/lib/polar/code-commands";

afterEach(cleanup);

function Composer({ onCommand, onSend }: { onCommand: (command: string, rest: string) => void; onSend: (text: string) => void }) {
    const [value, setValue] = useState("");
    const slash = useCodeSlash({
        value,
        onValueChange: setValue,
        skills: [],
        own: [],
        onSkill: null,
        place: "thread",
        commands: codeCommands.codeCommandsFor("thread", "claude"),
        onCommand
    });
    return (
        <div className="relative" data-testid="composer">
            {slash.list}
            <textarea
                aria-label="Reply"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                {...slash.textareaProps}
                onKeyDown={(event) => {
                    slash.textareaProps.onKeyDown(event);
                    if (event.defaultPrevented || event.key !== "Enter") return;
                    event.preventDefault();
                    if (!slash.run(value)) onSend(value);
                }}
            />
        </div>
    );
}

function mount() {
    const onCommand = vi.fn();
    const onSend = vi.fn();
    render(<Composer onCommand={onCommand} onSend={onSend} />, { wrapper: MessagesWrapper });
    const box = screen.getByLabelText("Reply") as HTMLTextAreaElement;
    const type = (text: string) => fireEvent.change(box, { target: { value: text } });
    const options = () => screen.queryAllByRole("option").map((option) => option.textContent ?? "");
    const highlighted = () =>
        screen.getAllByRole("option").find((option) => option.getAttribute("aria-selected") === "true")
            ?.textContent;
    return { onCommand, onSend, box, type, options, highlighted };
}

describe("the / list in Code", () => {
    it("opens on a slash with each command and its line, in a portal outside the composer", () => {
        const { type, options, box } = mount();
        expect(screen.queryByRole("listbox")).toBeNull();
        type("/");
        const list = screen.getByRole("listbox", { name: "Commands" });
        expect(options()).toHaveLength(11);
        expect(options()[0]).toMatch(/^\/help/);
        expect(screen.getByText("Summarize the agent's conversation to free room")).toBeTruthy();
        expect(screen.getByTestId("composer").contains(list)).toBe(false);
        expect(box.getAttribute("aria-controls")).toBe(list.id);
        expect(box.getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[0]!.id);
    });

    it("narrows as you type and closes once a space follows the name", () => {
        const { type, options } = mount();
        type("/com");
        expect(options()[0]).toMatch(/^\/compact/);
        type("/zzz");
        expect(screen.queryByRole("listbox")).toBeNull();
        type("/compact keep notes");
        expect(screen.queryByRole("listbox")).toBeNull();
        type("hello /");
        expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("walks with the arrows and runs the highlighted command on Enter", () => {
        const { type, box, highlighted, onCommand, onSend } = mount();
        type("/");
        fireEvent.keyDown(box, { key: "ArrowDown" });
        expect(highlighted()).toMatch(/^\/new/);
        fireEvent.keyDown(box, { key: "ArrowUp" });
        fireEvent.keyDown(box, { key: "ArrowUp" });
        // Up from the first wraps to the last.
        expect(highlighted()).toMatch(/^\/diff/);
        fireEvent.keyDown(box, { key: "Enter" });
        expect(onCommand).toHaveBeenCalledWith("diff", "");
        expect(onSend).not.toHaveBeenCalled();
        expect(box.value).toBe("");
        expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("puts a command that takes words in the box, and runs it with them", () => {
        const { type, box, onCommand } = mount();
        type("/comp");
        fireEvent.keyDown(box, { key: "Enter" });
        expect(onCommand).not.toHaveBeenCalled();
        expect(box.value).toBe("/compact ");
        type("/compact keep the plan");
        fireEvent.keyDown(box, { key: "Enter" });
        expect(onCommand).toHaveBeenCalledWith("compact", "keep the plan");
    });

    it("completes the name on Tab without running it", () => {
        const { type, box, onCommand } = mount();
        type("/sto");
        fireEvent.keyDown(box, { key: "Tab" });
        expect(box.value).toBe("/stop ");
        expect(onCommand).not.toHaveBeenCalled();
    });

    it("closes on Escape for that token, and a message that is not a command is sent", () => {
        const { type, box, onSend } = mount();
        type("/");
        fireEvent.keyDown(box, { key: "Escape" });
        expect(screen.queryByRole("listbox")).toBeNull();
        type("/h");
        expect(screen.getByRole("listbox")).toBeTruthy();
        type("fix the build");
        fireEvent.keyDown(box, { key: "Enter" });
        expect(onSend).toHaveBeenCalledWith("fix the build");
    });

    it("runs a pick by mouse and keeps the focus in the box", () => {
        const { type, box, onCommand } = mount();
        box.focus();
        type("/");
        fireEvent.mouseDown(screen.getByRole("option", { name: /\/stop/ }));
        expect(onCommand).toHaveBeenCalledWith("stop", "");
        expect(document.activeElement).toBe(box);
    });
});
