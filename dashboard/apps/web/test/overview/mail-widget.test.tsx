/**
 * The Overview's Mail card: still reading, unreadable, nothing unread, and the
 * newest unread messages each opening their conversation - and the app logos
 * the Overview's lists and its Customize panel draw beside a card or a visit.
 */

import { withMessages } from "../setup/i18n";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { OverviewMail } from "@/lib/overview/overview-service";

const { MailWidget } = await import("@/app/(app)/home/widgets/mail");
const { appOwningPath } = await import("@/lib/apps");
const { overviewWidgetApp } = await import("@/lib/overview/catalog");

const THREAD = "11111111-1111-4111-8111-111111111111";

function draw(data: OverviewMail | null | undefined, locale?: "es-ES"): string {
    return renderToStaticMarkup(withMessages(<MailWidget data={data} />, locale));
}

describe("the Mail card", () => {
    it("holds the rows' shape while they are read", () => {
        expect(draw(undefined)).toContain('aria-busy="true"');
    });

    it("says when the mail could not be read", () => {
        expect(draw(null)).toContain("Your mail could not be read just now.");
    });

    it("says nothing is unread and links to Mail", () => {
        const markup = draw({ unread: 0, messages: [] });
        expect(markup).toContain("Nothing unread in your inboxes.");
        expect(markup).toContain('href="/mail"');
    });

    it("counts what is unread and opens each message's conversation", () => {
        const markup = draw({
            unread: 12,
            messages: [
                {
                    threadId: THREAD,
                    subject: "",
                    from: "Ana",
                    at: "2026-11-11T10:00:00.000Z",
                    href: `/mail/t/${THREAD}`
                }
            ]
        });
        expect(markup).toContain(">12<");
        expect(markup).toContain(`href="/mail/t/${THREAD}"`);
        expect(markup).toContain("(no subject)");
        expect(markup).toContain("Ana");
        expect(draw({ unread: 1, messages: [] }, "es-ES")).toContain("No tienes nada sin leer.");
    });
});

describe("the app a page or a card belongs to", () => {
    it("is the app owning the path, and none for a path no app owns", () => {
        expect(appOwningPath("/mail/t/abc")?.id).toBe("mail");
        expect(appOwningPath("/tasks")?.id).toBe("tasks");
        expect(appOwningPath("/no-such-screen")).toBeNull();
    });

    it("names a card's app by its own screen, and none for a card of no app", () => {
        expect(overviewWidgetApp("mail")).toBe("mail");
        expect(overviewWidgetApp("calendar")).toBe("calendar");
        expect(overviewWidgetApp("shortcuts")).toBeNull();
    });
});
