// @vitest-environment jsdom

/**
 * Overview rows open what they are about wherever they are pressed, not only
 * on the name: the whole row is the one link, and nothing inside it is a
 * second control.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/app/(app)/tasks/actions", () => ({ updateTaskAction: async () => ({}) }));

const { StorageWidget, UsageWidget } = await import("@/app/(app)/home/widgets/infrastructure");

afterEach(cleanup);

describe("overview rows are whole links", () => {
    it("makes a Usage row one link holding its name, load and memory", () => {
        render(
            <UsageWidget
                data={[
                    {
                        id: "s1",
                        name: "lirio-0",
                        cpuPercent: 42,
                        memUsedBytes: 1024 ** 3,
                        memTotalBytes: 4 * 1024 ** 3,
                        spark: [10, 20, 30],
                        href: "/apps/servers/s1"
                    }
                ]}
            />,
            { wrapper: MessagesWrapper }
        );
        const links = screen.getAllByRole("link");
        expect(links).toHaveLength(1);
        const [row] = links;
        expect(row?.getAttribute("href")).toBe("/apps/servers/s1");
        expect(row?.textContent).toContain("lirio-0");
        expect(row?.textContent).toContain("42%");
        expect(row?.querySelector("a, button")).toBeNull();
    });

    it("makes a Storage row one link holding its name and its bar", () => {
        render(
            <StorageWidget
                data={[{ id: "d1", name: "NAS", usedBytes: 50, totalBytes: 100, href: "/drive/overview" }]}
            />,
            { wrapper: MessagesWrapper }
        );
        const links = screen.getAllByRole("link");
        expect(links).toHaveLength(1);
        expect(links[0]?.textContent).toContain("NAS");
        expect(links[0]?.textContent).toContain("50%");
    });
});
