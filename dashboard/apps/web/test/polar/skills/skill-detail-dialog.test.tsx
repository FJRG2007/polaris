// @vitest-environment jsdom
/**
 * The skill dialog: an Enigma or built-in skill opens on its SKILL.md, an
 * edit is saved against the upstream it was made on, the instance tier is
 * offered only to whoever the server says may write it, and an upstream that
 * moved after the edit offers merge, keep mine and take theirs.
 */

import { MessagesWrapper } from "../../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSkill, textHash } from "@/lib/polar/skills/overrides";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const UP = { description: "Use when testing.", instructions: "# Test\n\nOriginal body." };
const calls: { action: string; input: unknown }[] = [];
let current: ReturnType<typeof answer>;

function answer(resolved: ReturnType<typeof resolveSkill>, canInstance = false) {
    return { ok: true as const, value: { view: { key: "enigma:test-skill", name: "test-skill", resolved, enabled: null }, canInstance } };
}

vi.mock("@/app/(app)/polar/settings/skill-override-actions", () => ({
    readUpstreamSkillAction: async (input: unknown) => {
        calls.push({ action: "read", input });
        return current;
    },
    saveSkillOverrideAction: async (input: unknown) => {
        calls.push({ action: "save", input });
        return current;
    },
    resetSkillOverrideAction: async (input: unknown) => {
        calls.push({ action: "reset", input });
        return answer(resolveSkill(UP));
    },
    keepSkillOverrideAction: async (input: unknown) => {
        calls.push({ action: "keep", input });
        return current;
    }
}));

const { SkillDetailDialog } = await import("@/app/(app)/polar/settings/skill-detail-dialog");

afterEach(() => {
    cleanup();
    calls.length = 0;
});

function open(readOnly = false) {
    return render(
        <SkillDetailDialog target={{ kind: "upstream", key: "enigma:test-skill" }} readOnly={readOnly} onClose={() => undefined} />,
        { wrapper: MessagesWrapper }
    );
}

describe("SkillDetailDialog", () => {
    it("shows the SKILL.md and saves an edit against the upstream it saw", async () => {
        current = answer(resolveSkill(UP));
        open();
        await waitFor(() => expect(screen.getByText(/Original body\./)).toBeTruthy());
        expect(screen.queryByText("Everyone")).toBeNull();
        fireEvent.click(screen.getAllByRole("button", { name: /Edit/ }).at(-1)!);
        const editor = document.getElementById("skill-override-instructions") as HTMLTextAreaElement;
        fireEvent.change(editor, { target: { value: "# Test\n\nMy body." } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(calls.some((call) => call.action === "save")).toBe(true));
        expect(calls.find((call) => call.action === "save")!.input).toEqual({
            skill: "enigma:test-skill",
            tier: "user",
            against: textHash(UP),
            description: UP.description,
            instructions: "# Test\n\nMy body."
        });
    });

    it("offers the instance tier only when the server allows it", async () => {
        current = answer(resolveSkill(UP), true);
        open();
        await waitFor(() => expect(screen.getByText("Everyone")).toBeTruthy());
    });

    it("says when upstream moved after the edit, and resets on take theirs", async () => {
        const user = { ...UP, instructions: "Mine.", baseDescription: UP.description, baseInstructions: "Older upstream." };
        current = answer(resolveSkill(UP, null, user));
        open();
        await waitFor(() => expect(screen.getByRole("button", { name: /Merge/ })).toBeTruthy());
        expect(screen.getByRole("button", { name: "Keep mine" })).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Take theirs" }));
        await waitFor(() =>
            expect(calls.find((call) => call.action === "reset")?.input).toEqual({ skill: "enigma:test-skill", tier: "user" })
        );
    });

    it("reads without editing for somebody who cannot write", async () => {
        current = answer(resolveSkill(UP));
        open(true);
        await waitFor(() => expect(screen.getByText(/Original body\./)).toBeTruthy());
        expect(screen.queryByRole("button", { name: /Edit/ })).toBeNull();
    });
});
