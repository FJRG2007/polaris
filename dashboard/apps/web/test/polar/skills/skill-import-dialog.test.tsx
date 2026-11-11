// @vitest-environment jsdom
/**
 * The import review: what can be added is picked already, what cannot is
 * offered to be fixed instead, and Add says how many it adds and adds only
 * those.
 */

import { MessagesWrapper } from "../../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const imported: unknown[] = [];

vi.mock("@/app/(app)/polar/settings/skills-actions", () => ({
    importSkillsAction: async (input: { items: { skill: { name: string } }[] }) => {
        imported.push(input);
        return {
            ok: true,
            value: input.items.map((item) => ({
                ok: true,
                value: { id: item.skill.name, ...item.skill, enabled: true, source: "custom" }
            }))
        };
    },
    previewSkillImportAction: async () => ({ ok: false, error: "unused" }),
    searchSkillDirectoryAction: async () => ({ ok: true, value: [] })
}));
vi.mock("@/components/file-picker/use-choose-files", () => ({
    useChooseFiles: () => [async () => [], null]
}));

const { SkillImportDialog } = await import("@/app/(app)/polar/settings/polar-skill-import");

afterEach(cleanup);

const good = (name: string) => ({
    skill: { name, description: "When", instructions: "Do" },
    problem: null,
    origin: name
});

describe("reviewing an import", () => {
    it("adds what was picked, and sends what cannot be added to the editor", async () => {
        const onAdded = vi.fn();
        const onFix = vi.fn();
        const onClose = vi.fn();
        render(
            <SkillImportDialog
                open
                review={{
                    directory: null,
                    preview: {
                        audit: null,
                        candidates: [
                            good("one"),
                            good("two"),
                            {
                                skill: { name: "three", description: "", instructions: "Do" },
                                problem: "invalid",
                                origin: "three"
                            }
                        ]
                    }
                }}
                onClose={onClose}
                onAdded={onAdded}
                onFix={onFix}
            />,
            { wrapper: MessagesWrapper }
        );
        expect(screen.getByText("Missing a name, a description or instructions.")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Fix" }));
        expect(onFix).toHaveBeenCalledWith({
            draft: { name: "three", description: "", instructions: "Do" },
            directory: null
        });

        fireEvent.click(screen.getAllByRole("checkbox")[1]!);
        fireEvent.click(screen.getByRole("button", { name: "Add 1" }));
        await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
        expect(imported).toEqual([{ items: [{ skill: good("one").skill, directory: null }] }]);
        expect(onClose).toHaveBeenCalled();
    });
});
