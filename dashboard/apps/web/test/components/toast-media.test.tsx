// @vitest-environment jsdom

/**
 * A toast with a picture of what it is about draws it under the words, inside a
 * bounded box, so a tall photo never pushes the note down the screen.
 */

import { useEffect } from "react";
import { ToastProvider, useToast } from "@polaris/ui";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

function Raise() {
    const toast = useToast();
    useEffect(() => {
        toast.show({
            title: "Ada",
            body: "Sent a photo",
            media: <img src="/api/chat/attachments/f1" alt="Sent a photo" />
        });
    }, [toast]);
    return null;
}

afterEach(cleanup);

describe("a toast with media", () => {
    it("draws the picture under the words inside a bounded box", async () => {
        render(
            <ToastProvider>
                <Raise />
            </ToastProvider>
        );
        const picture = await screen.findByRole("img", { name: "Sent a photo" });
        expect(picture.getAttribute("src")).toBe("/api/chat/attachments/f1");
        expect(picture.parentElement?.className).toContain("max-h-40");
        expect(screen.getByText("Sent a photo", { selector: "span" })).toBeTruthy();
    });
});
