// @vitest-environment jsdom
/**
 * Pictures and files in Polar's composer and on its messages, as somebody
 * attaches them: pasted, dropped or picked, refused in a sentence when they
 * cannot go, shown as a thumbnail or Chat's file chip with their progress, kept
 * with a retry when the upload fails, and let go of (object URL revoked) when
 * removed. The upload itself is replaced; everything else is real.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    act,
    cleanup,
    createEvent,
    fireEvent,
    render,
    screen,
    waitFor
} from "@testing-library/react";

const chat = {
    messages: [] as Array<{ id: string; role: string; parts: Array<Record<string, unknown>> }>,
    sent: [] as Array<{ text?: string; files?: Array<Record<string, unknown>> }>
};

vi.mock("@ai-sdk/react", () => ({
    useChat: () => ({
        status: "ready",
        messages: chat.messages,
        error: undefined,
        sendMessage: async (message: (typeof chat.sent)[number]) => void chat.sent.push(message),
        stop: async () => undefined,
        setMessages: (next: typeof chat.messages) => {
            chat.messages = next;
        },
        regenerate: async () => undefined,
        addToolApprovalResponse: async () => undefined
    })
}));
vi.mock("next/navigation", () => ({
    usePathname: () => "/tasks",
    useRouter: () => ({ push: () => undefined })
}));

/** Each upload waits here until the test settles it. */
const uploads: Array<{
    name: string;
    progress: (moved: number, total: number) => void;
    settle: (ok: boolean) => void;
}> = [];

vi.mock("@/components/transfers/move-file", () => ({
    sendFile: (url: string, file: File, options: { onProgress?: (m: number, t: number) => void }) =>
        new Promise((resolve) => {
            const id = `00000000-0000-4000-8000-${String(uploads.length).padStart(12, "0")}`;
            uploads.push({
                name: file.name,
                progress: (moved, total) => options.onProgress?.(moved, total),
                settle: (ok) =>
                    resolve(
                        ok
                            ? {
                                  ok: true,
                                  status: 200,
                                  body: JSON.stringify({
                                      file: {
                                          id,
                                          url: `/api/polar/attachments/${id}`,
                                          filename: file.name,
                                          mediaType: file.type
                                      }
                                  })
                              }
                            : { ok: false, status: 503, body: '{"error":"storage_failed"}' }
                    )
            });
        })
}));

const PROVIDERS = [
    {
        provider: "anthropic",
        name: "Anthropic",
        payers: ["own"],
        models: [{ provider: "anthropic", model: "m-1", name: "Model One", reasoning: true }]
    }
];

const revoked: string[] = [];
let made = 0;

beforeEach(() => {
    chat.messages = [];
    chat.sent = [];
    uploads.length = 0;
    revoked.length = 0;
    made = 0;
    URL.createObjectURL = vi.fn(() => `blob:local/${++made}`);
    URL.revokeObjectURL = vi.fn((url: string) => void revoked.push(url));
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
            if (url === "/api/polar/models") {
                return Response.json({ providers: PROVIDERS, tools: {}, isAdmin: false });
            }
            if (url === "/api/polar/threads") return Response.json({ threads: [] });
            return Response.json({});
        })
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

const { PolarChat, pastedFiles, refusalOf } = await import("@/components/polar/polar-panel");

async function mount() {
    render(<PolarChat />, { wrapper: MessagesWrapper });
    await waitFor(() => expect(screen.getByText("Model One", { exact: false })).toBeTruthy());
    return screen.getByLabelText("Message Polar");
}

function paste(box: HTMLElement, files: File[]) {
    fireEvent.paste(box, { clipboardData: { files, items: [] } });
}

const png = (name = "shot.png", bytes = 2048) =>
    new File([new Uint8Array(bytes)], name, { type: "image/png" });

describe("attaching", () => {
    it("shows a pasted picture as a thumbnail with its progress, then opens it in the viewer", async () => {
        const box = await mount();
        paste(box, [png()]);
        const open = await screen.findByRole("button", { name: "Open shot.png" });
        expect(open.querySelector("img")?.getAttribute("src")).toBe("blob:local/1");
        act(() => uploads[0]!.progress(512, 1024));
        expect(screen.getByText("50%")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Send (Enter)" }).hasAttribute("disabled")).toBe(
            true
        );
        await act(async () => uploads[0]!.settle(true));
        // The local preview stays, so the picture does not blink.
        expect(open.querySelector("img")?.getAttribute("src")).toBe("blob:local/1");
        fireEvent.click(open);
        await waitFor(() => expect(document.querySelector("[data-image-viewer]")).toBeTruthy());
    });

    it("draws any other file as Chat's chip: name in full on hover, and its size", async () => {
        const box = await mount();
        const long = `${"quarterly-report-".repeat(6)}final.pdf`;
        paste(box, [new File([new Uint8Array(1536)], long, { type: "application/pdf" })]);
        await act(async () => uploads[0]!.settle(true));
        expect(screen.getByTitle(long).textContent).toBe(long);
        expect(screen.getByText("1.5 KB")).toBeTruthy();
    });

    it("takes a dropped file", async () => {
        const box = await mount();
        const form = box.closest("form")!;
        fireEvent.drop(form, { dataTransfer: { files: [png("dropped.png")], types: ["Files"] } });
        expect(await screen.findByRole("button", { name: "Open dropped.png" })).toBeTruthy();
    });

    it("leaves a text drag to the box, and keeps the error on screen", async () => {
        const box = await mount();
        paste(box, [new File(["x"], "tool.exe", { type: "application/x-msdownload" })]);
        await screen.findByRole("alert");
        const drop = createEvent.drop(box.closest("form")!, {
            dataTransfer: { files: [], types: ["text/plain"] }
        });
        fireEvent(box.closest("form")!, drop);
        expect(drop.defaultPrevented).toBe(false);
        expect(screen.getByRole("alert").textContent).toContain("tool.exe");
    });

    it("announces an upload starting and finishing, not every step of it", async () => {
        const box = await mount();
        paste(box, [png()]);
        const status = await screen.findByText("Uploading shot.png");
        act(() => uploads[0]!.progress(512, 1024));
        expect(status.textContent).toBe("Uploading shot.png");
        await act(async () => uploads[0]!.settle(true));
        expect(status.textContent).toBe("shot.png uploaded");
    });

    it("refuses a type or size it cannot take, in a sentence, without adding it", async () => {
        const box = await mount();
        paste(box, [new File(["x"], "tool.exe", { type: "application/x-msdownload" })]);
        expect((await screen.findByRole("alert")).textContent).toContain("tool.exe");
        paste(box, [png("huge.png", 11 * 1024 * 1024)]);
        expect(screen.getByRole("alert").textContent).toContain("huge.png is bigger than 10 MB.");
        expect(uploads).toHaveLength(0);
    });

    it("says so past the most a message carries, and attaches the ones that fit", async () => {
        const box = await mount();
        paste(
            box,
            Array.from({ length: 8 }, (_, index) => png(`p${index}.png`))
        );
        expect((await screen.findByRole("alert")).textContent).toContain("Up to 6 files");
        expect(uploads).toHaveLength(6);
    });

    it("keeps a failed upload with a retry that sends it again", async () => {
        const box = await mount();
        paste(box, [png()]);
        await act(async () => uploads[0]!.settle(false));
        expect(screen.getByRole("alert").textContent).toContain("couldn't be saved");
        fireEvent.click(screen.getByRole("button", { name: "Retry shot.png" }));
        expect(uploads).toHaveLength(2);
        await act(async () => uploads[1]!.settle(true));
        expect(screen.queryByRole("button", { name: "Retry shot.png" })).toBeNull();
    });

    it("lets go of the local preview when a picture is removed", async () => {
        const box = await mount();
        paste(box, [png()]);
        await act(async () => uploads[0]!.settle(true));
        fireEvent.click(screen.getByRole("button", { name: "Remove shot.png" }));
        expect(revoked).toEqual(["blob:local/1"]);
        expect(screen.queryByRole("button", { name: "Open shot.png" })).toBeNull();
    });

    it("sends the stored address with the size, and lets go of the preview", async () => {
        const box = await mount();
        paste(box, [png()]);
        await act(async () => uploads[0]!.settle(true));
        fireEvent.keyDown(box, { key: "Enter" });
        expect(chat.sent[0]?.files?.[0]).toMatchObject({
            url: "/api/polar/attachments/00000000-0000-4000-8000-000000000000",
            providerMetadata: { polaris: { size: 2048 } }
        });
        expect(revoked).toEqual(["blob:local/1"]);
    });
});

describe("a sent message", () => {
    it("shows its picture as a thumbnail and its file as a chip with the size it was sent with", async () => {
        chat.messages = [
            {
                id: "m1",
                role: "user",
                parts: [
                    {
                        type: "file",
                        mediaType: "image/png",
                        filename: "shot.png",
                        url: "/api/polar/attachments/00000000-0000-4000-8000-000000000001"
                    },
                    {
                        type: "file",
                        mediaType: "text/csv",
                        filename: "rows.csv",
                        url: "/api/polar/attachments/00000000-0000-4000-8000-000000000002",
                        providerMetadata: { polaris: { size: 3 * 1024 * 1024 } }
                    },
                    { type: "text", text: "Look" }
                ]
            }
        ];
        await mount();
        expect(screen.getByRole("button", { name: "Open shot.png" })).toBeTruthy();
        const chip = screen.getByText("rows.csv").closest("a");
        expect(chip?.getAttribute("href")).toBe(
            "/api/polar/attachments/00000000-0000-4000-8000-000000000002"
        );
        expect(screen.getByText("3 MB")).toBeTruthy();
        expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
    });
});

describe("the helpers", () => {
    it("reads pasted files from the items when the files list is empty", () => {
        const file = png();
        const data = {
            files: [],
            items: [
                { kind: "string", getAsFile: () => null },
                { kind: "file", getAsFile: () => file }
            ]
        } as unknown as DataTransfer;
        expect(pastedFiles(data)).toEqual([file]);
    });

    it("refuses by type and size before anything is sent", () => {
        expect(refusalOf({ type: "image/svg+xml", size: 1 })).toBe("unsupported_type");
        expect(refusalOf({ type: "image/png", size: 11 * 1024 * 1024 })).toBe("too_large");
        expect(refusalOf({ type: "application/pdf", size: 10 })).toBeNull();
    });
});
