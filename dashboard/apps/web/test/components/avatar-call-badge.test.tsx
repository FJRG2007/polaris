// @vitest-environment jsdom

/**
 * A face inside a call, drawn the way a voice channel draws it.
 *
 * Outside a call a face says where somebody is, and a speaker when they are on a
 * call. Inside one, everybody is on the call, so what a face says is whether they
 * can be heard: a crossed-out microphone, crossed-out headphones, or nothing.
 */

import { Avatar } from "@/components/avatar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const presence = vi.hoisted(() => ({ value: { status: "online", inCall: "call-1" } as unknown }));

vi.mock("@/components/presence-store", () => ({
    usePresence: (id: string | null) => (id ? presence.value : null)
}));
vi.mock("@/components/photo-access", () => ({ usePhotoOpenable: () => false }));

const PERSON = { id: "018f2b7a-0000-7000-8000-00000000000a", name: "Ada Lovelace" };

afterEach(() => {
    cleanup();
});

describe("a face outside a call", () => {
    it("still says its owner is on a call", () => {
        render(<Avatar person={PERSON} size={40} />);
        expect(screen.getByLabelText("On a call you can join")).toBeTruthy();
    });
});

describe("a face inside a call", () => {
    it("says nothing when they can be heard", () => {
        render(<Avatar person={PERSON} size={40} callBadge={null} />);
        expect(screen.queryByLabelText("On a call you can join")).toBeNull();
        expect(screen.queryByLabelText("Microphone off")).toBeNull();
        expect(screen.queryByLabelText("Not listening")).toBeNull();
    });

    it("says their microphone is off", () => {
        render(<Avatar person={PERSON} size={40} callBadge="muted" />);
        expect(screen.getByLabelText("Microphone off")).toBeTruthy();
        expect(screen.queryByLabelText("On a call you can join")).toBeNull();
    });

    it("says they are not listening, in place of the microphone", () => {
        render(<Avatar person={PERSON} size={40} callBadge="deafened" />);
        expect(screen.getByLabelText("Not listening")).toBeTruthy();
        expect(screen.queryByLabelText("Microphone off")).toBeNull();
    });
});
