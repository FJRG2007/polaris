// @vitest-environment jsdom
import { MessagesWrapper } from "../setup/i18n";
import { MetricBreakdownDialog } from "@/components/metrics/metric-breakdown";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const rows = [
    {
        key: "a",
        label: "Dashboard",
        kind: "container",
        detail: "The control plane",
        container: "polaris-web-903",
        value: 200,
        share: 0.2,
        href: "/apps/containers/a",
        group: "polaris"
    },
    {
        key: "b",
        label: "My site",
        kind: "container",
        detail: "Marketplace / Production",
        container: "marketplace-my-site-8a3f",
        service: { id: "app-1", source: "image", canRestart: true },
        value: 100,
        share: 0.1,
        href: "/apps/deploy/1",
        group: "apps"
    },
    {
        key: "free",
        label: "Free",
        kind: "rest",
        detail: null,
        value: 700,
        share: 0.7,
        href: null,
        group: "free"
    }
];

const restart = vi.fn(async () => ({}));
vi.mock("@/app/(app)/apps/deploy/actions", () => ({
    restartApplicationAction: (id: string) => restart(id)
}));

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

    it("names every row on its line, with where it lives and its container", async () => {
        await open();
        expect(screen.getByText("Dashboard")).toBeTruthy();
        expect(screen.getByText("The control plane")).toBeTruthy();
        expect(screen.getByText("Marketplace / Production")).toBeTruthy();
        expect(screen.getByText("marketplace-my-site-8a3f")).toBeTruthy();
        expect(screen.getAllByText("Free").length).toBe(2);
    });

    it("heads each owner with its subtotal, and leaves Free as its own row", async () => {
        await open();
        const headings = screen.getAllByRole("heading", { level: 3 });
        expect(headings.map((heading) => heading.textContent)).toEqual([
            expect.stringMatching(/^Polaris.*200 B.*20%$/),
            expect.stringMatching(/^Your apps.*100 B.*10%$/)
        ]);
    });

    it("restarts a service only after asking, in place", async () => {
        await open();
        fireEvent.click(screen.getByRole("button", { name: /My site/ }));
        expect(restart).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: /Restart now/ }));
        expect(restart).toHaveBeenCalledWith("app-1");
        expect(await screen.findByText("Restarted")).toBeTruthy();
    });
});
