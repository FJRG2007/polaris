// @vitest-environment jsdom
/**
 * Server terminal tabs: the tab that is highlighted is the session the panel
 * is connected to. The sidecar names the session on every attach, a resume
 * included, so only the tab that was opening a new shell may take a session id
 * from that frame - a resumed tab taking one gave two sessions the same panel
 * key, and switching between them kept typing into the first.
 */

import { useEffect, useState } from "react";
import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

let mounts: string[] = [];
let opened = 0;
let held: Array<{ id: string; name: string | null; number: number; mode: string }> = [];

vi.mock("../../src/app/(app)/apps/deploy/terminal-panel", () => ({
    TerminalPanel({
        resumeId,
        onSession
    }: {
        resumeId?: string;
        onSession?: (id: string, number: number) => void;
    }) {
        // A panel connects once, on mount, to the session it was given then.
        const [connected] = useState(() => resumeId ?? `new-${++opened}`);
        useEffect(() => {
            mounts.push(connected);
            if (!resumeId) held.push({ id: connected, name: null, number: 9, mode: "ssh" });
            onSession?.(connected, 9);
        }, []);
        return <div data-testid="panel">{connected}</div>;
    }
}));

const { ServerTerminals } = await import("../../src/app/(app)/apps/servers/server-terminals");

const SESSIONS = [
    { id: "A", name: "alpha", number: 1, mode: "ssh" },
    { id: "C", name: "charlie", number: 2, mode: "ssh" }
];

beforeEach(() => {
    mounts = [];
    opened = 0;
    held = [...SESSIONS];
    vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
            Response.json({ sessions: held, used: held.length, cap: 5, idleMinutes: 60 })
        )
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function renderTabs() {
    return render(
        <ServerTerminals hostId="h1" asRoot={false} login="deploy" address="10.0.0.2" />,
        { wrapper: MessagesWrapper }
    );
}

describe("server terminal tabs", () => {
    it("connects the panel to whichever tab is selected, back and forth", async () => {
        renderTabs();
        await waitFor(() => expect(screen.getByTestId("panel").textContent).toBe("C"));

        fireEvent.click(screen.getByRole("tab", { name: "alpha" }));
        await waitFor(() => expect(screen.getByTestId("panel").textContent).toBe("A"));

        fireEvent.click(screen.getByRole("tab", { name: "charlie" }));
        await waitFor(() => expect(screen.getByTestId("panel").textContent).toBe("C"));
        expect(screen.getByRole("tab", { name: "charlie" }).getAttribute("aria-selected")).toBe(
            "true"
        );
        // One connection per switch, none spent re-keying a resumed tab.
        expect(mounts).toEqual(["C", "A", "C"]);
    });

    it("keeps a new tab on its own socket once its session id arrives", async () => {
        renderTabs();
        await waitFor(() => expect(screen.getByTestId("panel").textContent).toBe("C"));

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
        });
        await waitFor(() => expect(screen.getByTestId("panel").textContent).toBe("new-1"));
        // The new session is listed and selected without a second connection.
        await waitFor(() =>
            expect(screen.getByRole("tab", { name: "Shell 9" }).getAttribute("aria-selected")).toBe(
                "true"
            )
        );
        expect(mounts).toEqual(["C", "new-1"]);

        fireEvent.click(screen.getByRole("tab", { name: "alpha" }));
        await waitFor(() => expect(screen.getByTestId("panel").textContent).toBe("A"));
        expect(mounts).toEqual(["C", "new-1", "A"]);
    });
});
