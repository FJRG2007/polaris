// @vitest-environment jsdom
import { MessagesWrapper } from "../setup/i18n";
import { MetricBreakdownDialog } from "@/components/metrics/metric-breakdown";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const rows = [
    { key: "a", label: "Polaris - web", kind: "container", detail: null, value: 200, share: 0.2, href: "/apps/containers/a", group: "polaris" },
    { key: "b", label: "My site", kind: "container", detail: null, value: 100, share: 0.1, href: "/apps/deploy/1", group: "apps" },
    { key: "free", label: "Free", kind: "rest", detail: null, value: 700, share: 0.7, href: null, group: "free" }
];

vi.mock("@/components/shared-polls", () => ({
    subjectBreakdown: async () => ({ rows, total: 1000, note: "", unavailable: null, at: null })
}));

afterEach(cleanup);

describe("the list behind a metric", () => {
    async function open() {
        render(
            <MessagesWrapper>
                <MetricBreakdownDialog
                    subject={{ kind: "server", id: "local" }}
                    open={{ metric: "mem", from: 1, to: 2 }}
                    onClose={() => undefined}
                />
            </MessagesWrapper>
        );
        return screen.findByRole("link", { name: /My site/ });
    }

    it("makes the whole row open what it names, and only rows with a page", async () => {
        expect((await open()).getAttribute("href")).toBe("/apps/deploy/1");
        expect(screen.queryByRole("link", { name: /Free/ })).toBeNull();
    });

    it("narrows to one owner and back", async () => {
        await open();
        const polaris = screen.getByRole("button", { name: /Polaris/ });
        fireEvent.click(polaris);
        expect(screen.queryByRole("link", { name: /My site/ })).toBeNull();
        fireEvent.click(polaris);
        expect(screen.getByRole("link", { name: /My site/ })).toBeTruthy();
    });
});
