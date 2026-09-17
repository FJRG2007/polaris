// @vitest-environment jsdom

/**
 * The faces in a call, as the people outside it see them.
 *
 * Each face carries the same mark it wears inside the call: a crossed-out
 * microphone, crossed-out headphones when they are not listening either, and
 * nothing when they can be heard.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CallRoster, VoiceStateIcons, callBadgeOf } from "@/app/(app)/chat/call-roster";

vi.mock("@/components/presence-store", () => ({ usePresence: () => null }));
vi.mock("@/components/photo-access", () => ({ usePhotoOpenable: () => false }));
vi.mock("@/components/person-name", async (importOriginal) => ({
    ...(await importOriginal<object>()),
    PersonName: ({ name }: { name: string }) => <>{name}</>,
    PersonRow: ({ children, className }: { children: React.ReactNode; className?: string }) => (
        <li className={className}>{children}</li>
    )
}));

const person = (id: string, name: string, muted: boolean, deafened: boolean) => ({
    id,
    name,
    userId: null,
    muted,
    deafened
});

afterEach(() => {
    cleanup();
});

describe("the mark on a face in a call", () => {
    it("is deafened over muted, and nothing when they can be heard", () => {
        expect(callBadgeOf({ muted: true, deafened: true })).toBe("deafened");
        expect(callBadgeOf({ muted: true, deafened: false })).toBe("muted");
        expect(callBadgeOf({ muted: false, deafened: false })).toBeNull();
    });
});

describe("the roster outside a call", () => {
    it("names everybody in it with their mark", () => {
        render(
            <CallRoster
                people={[
                    person("p1", "Ada", false, false),
                    person("p2", "Grace", true, false),
                    person("p3", "Linus", true, true)
                ]}
            />
        );
        expect(screen.getByText("Ada")).toBeTruthy();
        expect(screen.getByText("Grace")).toBeTruthy();
        expect(screen.getAllByLabelText("Microphone off")).toHaveLength(1);
        expect(screen.getAllByLabelText("Not listening")).toHaveLength(1);
    });

    it("draws nothing for an empty room", () => {
        const { container } = render(<CallRoster people={[]} />);
        expect(container.innerHTML).toBe("");
    });

    it("marks a row too small for a badge with an icon", () => {
        render(<VoiceStateIcons person={{ muted: true, deafened: false }} />);
        expect(screen.getByLabelText("Microphone off")).toBeTruthy();
    });

    it("draws a guest from the name they gave, asking for no picture", () => {
        const { container } = render(
            <CallRoster people={[person("s2", "Visitor", false, false)]} />
        );
        expect(screen.getByText("Visitor")).toBeTruthy();
        expect(container.querySelector("img")).toBeNull();
    });
});
