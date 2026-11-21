// @vitest-environment jsdom

/**
 * The "+" sheet inside the Polaris phone app: the recent photos and videos in a
 * grid, the way Discord and Signal show them, read from the gallery by the app.
 * Asked for the first time, every refusal with a way on, a tap that puts the
 * photo straight on the message (and a second that takes it off), and a browser
 * left with the system chooser.
 */

import { useState } from "react";
import { MessagesWrapper } from "../setup/i18n";
import { AttachSheet } from "@/app/(app)/chat/attach-sheet";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

type Answer = (op: string, args: Record<string, unknown>) => unknown;

const PHOTO = btoa("photo-bytes");

function phoneApp(answer: Answer) {
    const calls: string[] = [];
    const target = window as unknown as Record<string, unknown>;
    target.polarisMobile = {
        canMedia: () => true,
        mediaCall: (id: string, op: string, args: string) => {
            calls.push(op);
            const reply = answer(op, JSON.parse(args) as Record<string, unknown>);
            queueMicrotask(() =>
                (target.__polarisMobileMedia as (id: string, json: string) => void)(id, JSON.stringify(reply))
            );
        }
    };
    return calls;
}

function library(access: string): Answer {
    let granted = access;
    return (op, args) => {
        if (op === "access") return { access: granted };
        if (op === "request" || op === "manage") {
            granted = "full";
            return { access: granted };
        }
        if (op === "settings") return {};
        if (op === "list") {
            return {
                items: [
                    { id: "p1", video: false, duration: 0, name: "a.jpg", mime: "image/jpeg", size: 11 },
                    { id: "v1", video: true, duration: 42_000, name: "b.mp4", mime: "video/mp4", size: 11 },
                    { id: "big", video: true, duration: 3_725_000, name: "c.mp4", mime: "video/mp4", size: 900 * 1024 * 1024 }
                ],
                more: false
            };
        }
        if (op === "thumb") return { src: "data:image/jpeg;base64,AAAA" };
        if (op === "read") return { data: PHOTO, size: 11, done: true, offset: args.offset };
        return { error: "unknown" };
    };
}

/** The sheet beside a composer's staged files, the way the composer wires it. */
function Composed({ onAttach }: { onAttach: (files: File[]) => void }) {
    const [files, setFiles] = useState<File[]>([]);
    return (
        <>
            <ul aria-label="Staged">
                {files.map((file) => (
                    <li key={file.name}>{file.name}</li>
                ))}
            </ul>
            <AttachSheet
                open
                onOpenChange={() => undefined}
                onMedia={() => undefined}
                attached={files}
                onAttach={(picked) => {
                    onAttach(picked);
                    setFiles((current) => [...current, ...picked]);
                }}
                onDetach={(file) => setFiles((current) => current.filter((one) => one !== file))}
                onFiles={() => undefined}
                maxBytes={100 * 1024 * 1024}
            />
        </>
    );
}

function sheet(onMedia = vi.fn()) {
    render(
        <AttachSheet
            open
            onOpenChange={() => undefined}
            onMedia={onMedia}
            onFiles={() => undefined}
            onPoll={() => undefined}
            maxBytes={100 * 1024 * 1024}
        />,
        { wrapper: MessagesWrapper }
    );
    return onMedia;
}

beforeEach(() => {
    vi.stubGlobal(
        "IntersectionObserver",
        class {
            constructor(private readonly fire: (entries: { isIntersecting: boolean }[]) => void) {}
            observe() {
                queueMicrotask(() => this.fire([{ isIntersecting: true }]));
            }
            disconnect() {}
        }
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    const target = window as unknown as Record<string, unknown>;
    delete target.polarisMobile;
});

describe("recent photos in the phone app's + sheet", () => {
    it("asks for access the first time, then shows the grid", async () => {
        const calls = phoneApp(library("prompt"));
        sheet();
        fireEvent.click(await screen.findByRole("button", { name: "Allow access" }));
        expect(await screen.findByRole("button", { name: "Video, 0:42" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Photo" })).toBeTruthy();
        expect(calls).toContain("request");
        // The camera is the first square, and the rest of the gallery stays a tile away.
        expect(screen.getByRole("button", { name: "Camera" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Photos" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Files" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Poll" })).toBeTruthy();
    });

    it("puts a tapped photo straight on the message, and takes it off on a second tap", async () => {
        phoneApp(library("full"));
        const onAttach = vi.fn();
        render(<Composed onAttach={onAttach} />, { wrapper: MessagesWrapper });
        const video = await screen.findByRole("button", { name: "Video, 0:42" });
        fireEvent.click(video);
        await waitFor(() => expect(video.getAttribute("aria-pressed")).toBe("true"));
        fireEvent.click(screen.getByRole("button", { name: "Photo" }));
        await waitFor(() => expect(onAttach).toHaveBeenCalledTimes(2));
        const files = onAttach.mock.calls.map((call) => (call[0] as File[])[0]!);
        expect(files.map((file) => [file.name, file.type, file.size])).toEqual([
            ["b.mp4", "video/mp4", 11],
            ["a.jpg", "image/jpeg", 11]
        ]);
        expect(screen.getByRole("list", { name: "Staged" }).textContent).toBe("b.mp4a.jpg");
        // Sent with the composer's own Send: there is no button of the grid's own.
        expect(screen.queryByRole("button", { name: /^Add/ })).toBeNull();
        expect(within(video).getByText("1")).toBeTruthy();

        fireEvent.click(video);
        await waitFor(() => expect(screen.getByRole("list", { name: "Staged" }).textContent).toBe("a.jpg"));
        expect(video.getAttribute("aria-pressed")).toBe("false");
        expect(onAttach).toHaveBeenCalledTimes(2);
    });

    it("opens at the keyboard's height, in the page under the composer", async () => {
        phoneApp(library("full"));
        render(<Composed onAttach={() => undefined} />, { wrapper: MessagesWrapper });
        const panel = screen.getByRole("region", { name: "Add to the message" });
        expect(panel.closest("[role=dialog]")).toBeNull();
        expect(Number.parseInt(panel.style.height, 10)).toBeGreaterThan(0);
        await screen.findByRole("button", { name: "Photo" });
    });

    it("will not choose what is too large to send here", async () => {
        phoneApp(library("full"));
        sheet();
        const big = await screen.findByRole("button", { name: "Video, 1:02:05, Too large" });
        fireEvent.click(big);
        expect(big.getAttribute("aria-pressed")).toBe("false");
        expect(screen.queryByRole("button", { name: /^Add/ })).toBeNull();
    });

    it("offers Manage on a chosen selection", async () => {
        const calls = phoneApp(library("limited"));
        sheet();
        fireEvent.click(await screen.findByRole("button", { name: "Manage" }));
        await waitFor(() => expect(calls).toContain("manage"));
        await waitFor(() => expect(screen.queryByRole("button", { name: "Manage" })).toBeNull());
    });

    it("sends a refusal to Settings, never a dead end", async () => {
        const calls = phoneApp(library("denied"));
        sheet();
        fireEvent.click(await screen.findByRole("button", { name: "Open Settings" }));
        await waitFor(() => expect(calls).toContain("settings"));
        expect(screen.getByRole("button", { name: "Photos" })).toBeTruthy();
    });

    it("keeps the system chooser in a browser", () => {
        sheet();
        expect(screen.queryByRole("region", { name: "Recent photos and videos" })).toBeNull();
        for (const name of ["Camera", "Photos", "Files", "Poll"]) {
            expect(screen.getByRole("button", { name })).toBeTruthy();
        }
    });
});

describe("the ways to add something", () => {
    it("each wear a colour of their own, as WhatsApp's do", () => {
        sheet();
        const tones = ["Camera", "Photos", "Files", "Poll"].map((name) => {
            const circle = screen.getByRole("button", { name }).querySelector("span");
            return [...(circle?.classList ?? [])].find((one) => /^bg-[a-z]+-\d+$/.test(one));
        });
        expect(tones.every(Boolean)).toBe(true);
        expect(new Set(tones).size).toBe(tones.length);
    });
});
