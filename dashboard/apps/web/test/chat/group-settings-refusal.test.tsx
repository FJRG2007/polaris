// @vitest-environment jsdom

/**
 * A group switch the server refuses.
 *
 * The switch is shown flipped while the save runs and put back when it fails -
 * and a switch that flips back with nothing said reads as a bug in the page
 * rather than as a refusal. The action answers with its refusal instead of
 * throwing it, which is why the error has to be taken off the result.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

let refusal: string | null = null;
const saved: unknown[] = [];

vi.mock("@/app/(app)/chat/actions", () => ({
    listMembersAction: async () => ({ members: [] }),
    setGroupOptionsAction: async (_channelId: string, options: unknown) => {
        saved.push(options);
        return refusal ? { error: refusal } : {};
    },
    transferGroupAction: async () => ({})
}));
vi.mock("@/components/avatar", () => ({ Avatar: () => null }));
vi.mock("@/components/person-name", () => ({
    PersonName: ({ name }: { name: string }) => <span>{name}</span>,
    PersonRow: ({ children }: { children: React.ReactNode }) => <li>{children}</li>
}));

const { GroupSettingsDialog } = await import("@/app/(app)/chat/group-settings-dialog");

const channel = {
    id: "channel-1",
    name: "Weekend plans",
    kind: "group",
    ownerId: "ada",
    membersMayEdit: false,
    membersMayInvite: true
} as never;

beforeEach(() => {
    refusal = null;
    saved.length = 0;
});

afterEach(() => cleanup());

describe("the group's own switches", () => {
    it("says what the server refused, and puts the switch back", async () => {
        refusal = "Only the owner of this group can do that";
        render(
            <GroupSettingsDialog
                channel={channel}
                open
                onOpenChange={() => undefined}
                onChanged={() => undefined}
            />
        );

        const invite = screen.getByLabelText("Let anybody add people");
        expect(invite.getAttribute("aria-checked")).toBe("true");
        await act(async () => {
            fireEvent.click(invite);
        });

        expect(saved).toEqual([{ membersMayInvite: false }]);
        expect(screen.getByRole("alert").textContent).toContain("Only the owner");
        expect(screen.getByLabelText("Let anybody add people").getAttribute("aria-checked")).toBe(
            "true"
        );
    });

    it("keeps the switch where it was put when the server accepts it", async () => {
        render(
            <GroupSettingsDialog
                channel={channel}
                open
                onOpenChange={() => undefined}
                onChanged={() => undefined}
            />
        );
        await act(async () => {
            fireEvent.click(screen.getByLabelText("Let anybody add people"));
        });
        expect(saved).toEqual([{ membersMayInvite: false }]);
        expect(screen.queryByRole("alert")).toBeNull();
        expect(screen.getByLabelText("Let anybody add people").getAttribute("aria-checked")).toBe(
            "false"
        );
    });
});
