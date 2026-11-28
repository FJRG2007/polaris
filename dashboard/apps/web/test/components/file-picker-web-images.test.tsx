// @vitest-environment jsdom

/**
 * The shared picker's "Search the web" tab: offered wherever images are being
 * picked and nowhere else, one settled search for a typed query, and a chosen
 * image handed back as an ordinary upload with its credit.
 */

import { MessagesWrapper } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { webImageTypes } from "@/components/file-picker/web-image-types";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { FilePickerDialog } from "@/components/file-picker/file-picker-dialog";

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

const ID = "ov:f561777d-24ea-483f-9cf8-f17aa1fd6aa3";
const RESULT = {
    id: ID,
    title: "Red fox",
    width: 1024,
    height: 680,
    credit: {
        provider: "openverse",
        title: "Red fox",
        creator: "Someone",
        creatorUrl: "",
        license: "CC BY 2.0",
        licenseUrl: "https://creativecommons.org/licenses/by/2.0/",
        sourceUrl: "https://www.flickr.com/photos/someone/1"
    }
};

function stubNetwork(results: unknown[] = [RESULT]) {
    const asked: string[] = [];
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string) => {
            asked.push(input);
            if (input.startsWith("/api/picker/web-images/image")) {
                return new Response(new Blob([new Uint8Array([0x89, 0x50])], { type: "image/png" }), {
                    headers: { "x-polaris-filename": encodeURIComponent("Red fox.png") }
                });
            }
            if (input.startsWith("/api/picker/web-images")) {
                return new Response(JSON.stringify({ results, more: false }), {
                    headers: { "content-type": "application/json" }
                });
            }
            return new Response(JSON.stringify({ sources: [], entries: [] }), {
                headers: { "content-type": "application/json" }
            });
        })
    );
    return asked;
}

describe("webImageTypes", () => {
    it("offers the tab to a screen that takes images it can hand back", () => {
        expect(webImageTypes("image/*")).toEqual(["image/png", "image/jpeg", "image/webp", "image/gif"]);
        expect(webImageTypes(undefined)).toHaveLength(4);
        expect(webImageTypes("image/png,.JPG")).toEqual(["image/png", "image/jpeg"]);
    });

    it("never to one that takes no such image, or only stored files", () => {
        expect(webImageTypes(".pdf,.docx")).toEqual([]);
        expect(webImageTypes("image/svg+xml")).toEqual([]);
        expect(webImageTypes("image/*", true)).toEqual([]);
    });
});

describe("the Search the web tab", () => {
    it("is not there on a screen that picks no images", () => {
        stubNetwork();
        render(<FilePickerDialog accept=".pdf" onPick={() => {}} onClose={() => {}} />, {
            wrapper: MessagesWrapper
        });
        expect(screen.queryByRole("button", { name: "Search the web" })).toBeNull();
    });

    it("searches once for what was typed, and hands the chosen image back as an upload with its credit", async () => {
        const asked = stubNetwork();
        const onPick = vi.fn();
        const user = userEvent.setup();
        render(<FilePickerDialog accept="image/*" multiple={false} onPick={onPick} onClose={() => {}} />, {
            wrapper: MessagesWrapper
        });
        await user.click(screen.getByRole("button", { name: "Search the web" }));
        expect(screen.getByText("Search openly licensed images")).toBeTruthy();

        await user.type(screen.getByRole("searchbox", { name: "Search for images" }), "  Red  Fox");
        const tile = await screen.findByRole("button", { name: "Red fox, CC BY 2.0" });
        const searches = asked.filter((one) => one.startsWith("/api/picker/web-images?"));
        expect(searches).toEqual(["/api/picker/web-images?q=red%20fox&page=1&safe=1"]);
        expect(tile.querySelector("img")?.getAttribute("src")).toBe(
            `/api/picker/web-images/image?id=${encodeURIComponent(ID)}&size=thumb`
        );

        await user.click(tile);
        expect(tile.getAttribute("aria-pressed")).toBe("true");
        expect(screen.getByText("by Someone", { exact: false })).toBeTruthy();
        await user.click(screen.getByRole("button", { name: "Attach" }));

        await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1));
        const [picks] = onPick.mock.calls[0] as [{ kind: string; file: File; credit: unknown }[]];
        expect(picks[0]?.kind).toBe("upload");
        expect(picks[0]?.file.name).toBe("Red fox.png");
        expect(picks[0]?.file.type).toBe("image/png");
        expect(picks[0]?.credit).toEqual(RESULT.credit);
    });

    it("asks again with SafeSearch off when it is switched off", async () => {
        const asked = stubNetwork();
        const user = userEvent.setup();
        render(<FilePickerDialog accept="image/*" onPick={() => {}} onClose={() => {}} />, {
            wrapper: MessagesWrapper
        });
        await user.click(screen.getByRole("button", { name: "Search the web" }));
        await user.type(screen.getByRole("searchbox", { name: "Search for images" }), "otter");
        await screen.findByRole("button", { name: "Red fox, CC BY 2.0" });
        await user.click(screen.getByRole("switch", { name: "SafeSearch" }));
        await waitFor(() =>
            expect(asked).toContain("/api/picker/web-images?q=otter&page=1&safe=0")
        );
    });

    it("says so in words when nothing matches", async () => {
        stubNetwork([]);
        const user = userEvent.setup();
        render(<FilePickerDialog accept="image/*" onPick={() => {}} onClose={() => {}} />, {
            wrapper: MessagesWrapper
        });
        await user.click(screen.getByRole("button", { name: "Search the web" }));
        await user.type(screen.getByRole("searchbox", { name: "Search for images" }), "zzqx");
        expect(await screen.findByText('No images match "zzqx"')).toBeTruthy();
    });
});
