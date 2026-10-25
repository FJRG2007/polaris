// @vitest-environment jsdom

/**
 * A message sent with several pictures: once one is open, the arrow keys step
 * to the others, round the ends, and a lone picture does not react.
 */

import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { messageGallery } from "@/app/(app)/chat/message-gallery";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ImageViewer, type ViewedImage } from "@/components/image-viewer";

afterEach(cleanup);

type Attachment = Parameters<typeof messageGallery>[0]["attachments"][number];
const picture = (id: string) =>
    ({ id, name: `${id}.png`, inline: true, spoiler: false }) as Attachment;

function Viewer({ ids, open }: { ids: string[]; open: string }) {
    const message = { id: "m1", forwardable: true, attachments: ids.map(picture) };
    const [viewing, setViewing] = useState<ViewedImage | null>(
        messageGallery(message, false, `/api/chat/attachments/${open}`).find((image) =>
            image.url.endsWith(`/${open}`)
        ) ?? null
    );
    const gallery = viewing ? messageGallery(message, false, viewing.url) : undefined;
    return (
        <>
            <output data-testid="open">{viewing?.name ?? ""}</output>
            <ImageViewer
                image={viewing}
                gallery={gallery}
                onNavigate={setViewing}
                onClose={() => setViewing(null)}
            />
        </>
    );
}

const press = (key: string) =>
    act(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key, cancelable: true }));
    });

describe("stepping through a message's pictures", () => {
    it("moves with the arrows and wraps at the ends", () => {
        render(<Viewer ids={["a", "b", "c"]} open="b" />);
        const open = () => screen.getByTestId("open").textContent;
        expect(open()).toBe("b.png");
        press("ArrowRight");
        expect(open()).toBe("c.png");
        press("ArrowRight");
        expect(open()).toBe("a.png");
        press("ArrowLeft");
        expect(open()).toBe("c.png");
    });

    it("stays put on a message with one picture", () => {
        render(<Viewer ids={["a"]} open="a" />);
        press("ArrowRight");
        expect(screen.getByTestId("open").textContent).toBe("a.png");
    });
});
