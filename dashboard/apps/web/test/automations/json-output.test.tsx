// @vitest-environment jsdom

/**
 * A step's input and output read as JSON does everywhere else in Polaris: with
 * the shared highlighter's colours, not as a grey block of plain text.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/app/(app)/automations/actions", () => ({}));

const { MessagesWrapper } = await import("../setup/i18n");
const { DataBlock } = await import("@/app/(app)/automations/runs/[runId]/run-detail");

afterEach(cleanup);

describe("a step's data", () => {
    it("is painted by the JSON highlighter", async () => {
        const { container } = render(
            <MessagesWrapper>
                <DataBlock title="Output" value={{ sent: true, channels: ["bell"] }} />
            </MessagesWrapper>
        );
        expect(screen.getByText("Output")).toBeTruthy();
        await waitFor(() => expect(container.querySelector("[class^='hljs-']")).not.toBeNull());
        expect(container.textContent).toContain('"sent": true');
    });

    it("says there is nothing when there is no data", () => {
        const { container } = render(
            <MessagesWrapper>
                <DataBlock title="Input" value={null} />
            </MessagesWrapper>
        );
        expect(container.querySelector("[class^='hljs-']")).toBeNull();
    });
});
