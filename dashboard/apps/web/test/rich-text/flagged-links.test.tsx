// @vitest-environment jsdom
/**
 * A link a reputation service flagged, as the reader meets it.
 *
 * It is marked where it sits and asks before it opens; going back is the
 * default, continuing opens it the way any outside link opens. A link that was
 * not flagged - clean or never checked - is drawn exactly as before.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RichText } from "@/components/rich-text/rich-text";
import { MessagesWrapper } from "../setup/i18n";

afterEach(cleanup);

const BAD = "https://bad.example/login?utm_source=chat";
const FLAG = { url: "https://bad.example/login", provider: "virustotal" };

function draw(markdown: string, flags = [FLAG]) {
    return render(<RichText value={markdown} flaggedLinks={flags} />, { wrapper: MessagesWrapper });
}

describe("a flagged link", () => {
    it("is marked, matched through the same normalization the check used", () => {
        draw(`look ${BAD}`);
        const link = screen.getByRole("link");
        expect(link.getAttribute("title")).toBe("Flagged by VirusTotal");
    });

    it("asks before opening, and going back opens nothing", () => {
        const open = vi.spyOn(window, "open").mockImplementation(() => null);
        draw(`look ${BAD}`);
        fireEvent.click(screen.getByRole("link"));
        expect(screen.getByText("This link may be unsafe")).toBeTruthy();
        expect(screen.getByText(/VirusTotal flagged this address/)).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Go back" }));
        expect(open).not.toHaveBeenCalled();
        open.mockRestore();
    });

    it("opens in a new tab that cannot reach back once the reader continues", () => {
        const open = vi.spyOn(window, "open").mockImplementation(() => null);
        draw(`look ${BAD}`);
        fireEvent.click(screen.getByRole("link"));
        fireEvent.click(screen.getByRole("button", { name: "Continue anyway" }));
        expect(open).toHaveBeenCalledWith(BAD, "_blank", "noopener,noreferrer");
        open.mockRestore();
    });
});

describe("a link nobody flagged", () => {
    it("opens as it always has", () => {
        draw("look https://good.example/page");
        const link = screen.getByRole("link");
        expect(link.getAttribute("title")).toBeNull();
        expect(link.getAttribute("href")).toBe("https://good.example/page");
        expect(link.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    });

    it("is untouched when the message has no flags at all", () => {
        draw(`look ${BAD}`, []);
        expect(screen.getByRole("link").getAttribute("title")).toBeNull();
    });
});
