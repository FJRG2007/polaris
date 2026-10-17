// @vitest-environment jsdom

/**
 * The editor pieces of flow control, rendered with the real catalogs: the
 * nested AND/OR/NOT condition editor, "if this fails" with its retry, how the
 * triggers combine, a Choose's cases, and the words a run detail and the
 * canvas use for ports and loop passes.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/app/(app)/automations/actions", () => ({ rotateHookAction: vi.fn() }));

import * as core from "@polaris/core";
import { MessagesWrapper } from "../setup/i18n";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { AutomationDetail } from "@/lib/automations/service";
import { passOf, portLabel } from "@/app/(app)/automations/shared";
import {
    ConditionEditor,
    FailureFields,
    FlowNodeFields,
    WhenFields,
    emptyCondition
} from "@/app/(app)/automations/[id]/flow-fields";

beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

const draft = (nodes: core.GraphNode[]): core.AutomationGraph =>
    core.automationGraphSchema.parse({ nodes, edges: [] });
const node = (
    id: string,
    type: string,
    config: unknown = {},
    extra: Partial<core.GraphNode> = {}
) => ({ id, type, typeVersion: 1, config, ...extra }) as core.GraphNode;

describe("the condition editor", () => {
    it("adds a nested group and turns a group into NOT", () => {
        const onChange = vi.fn();
        render(<ConditionEditor value={emptyCondition()} onChange={onChange} triggers={[]} />, {
            wrapper: MessagesWrapper
        });
        fireEvent.click(screen.getByRole("button", { name: "Add group" }));
        const grouped = onChange.mock.calls.at(-1)![0] as core.ConditionGroup;
        expect(grouped.items).toHaveLength(2);
        expect(grouped.items[1]).toMatchObject({ kind: "group", join: "any" });
        fireEvent.click(screen.getByRole("checkbox", { name: "Not" }));
        expect(onChange.mock.calls.at(-1)![0]).toMatchObject({ negate: true });
        // One trigger: nothing to tell apart, so "Started by" is not offered.
        expect(screen.queryByRole("button", { name: "Add started by" })).toBeNull();
    });

    it("draws a nested group as its own editor and offers Started by with two triggers", () => {
        const value: core.ConditionGroup = {
            kind: "group",
            join: "all",
            items: [{ kind: "group", join: "any", negate: true, items: [] }]
        };
        render(
            <ConditionEditor
                value={value}
                onChange={() => undefined}
                triggers={[
                    { id: "t1", label: "1. Run by hand" },
                    { id: "t2", label: "2. Webhook" }
                ]}
            />,
            { wrapper: MessagesWrapper }
        );
        expect(screen.getAllByRole("group", { name: "Conditions" })).toHaveLength(2);
        const nots = screen.getAllByRole("checkbox", { name: "Not" }) as HTMLInputElement[];
        expect(nots.map((box) => box.checked)).toEqual([false, true]);
        expect(screen.getAllByRole("button", { name: "Add started by" }).length).toBeGreaterThan(0);
    });
});

describe("if this fails", () => {
    it("switches a retry on with its defaults and shows its fields", () => {
        const onChange = vi.fn();
        const http = node("h", "core.http");
        const { rerender } = render(<FailureFields node={http} onChange={onChange} allowPort />, {
            wrapper: MessagesWrapper
        });
        expect(screen.queryByLabelText("Tries")).toBeNull();
        fireEvent.click(screen.getByRole("checkbox", { name: "Try again before giving up" }));
        expect(onChange).toHaveBeenLastCalledWith({
            retry: { tries: 3, waitSeconds: 30, backoff: "fixed" }
        });
        rerender(
            <FailureFields
                node={{ ...http, retry: { tries: 3, waitSeconds: 30, backoff: "fixed" } }}
                onChange={onChange}
                allowPort
            />
        );
        expect(screen.getByLabelText("Tries")).toBeTruthy();
        expect(screen.getByText("Every failed try shows in the run as Retried.")).toBeTruthy();
    });

    it("is not offered on nodes that cannot fail on their own", () => {
        const { container } = render(
            <FailureFields node={node("j", "core.join")} onChange={() => undefined} allowPort />,
            { wrapper: MessagesWrapper }
        );
        expect(container.textContent).toBe("");
    });
});

describe("how the triggers combine", () => {
    it("stays out of the way with one trigger and shows the window for at least N", () => {
        const { container, rerender } = render(
            <WhenFields when={{ kind: "any" }} triggers={1} onChange={() => undefined} />,
            { wrapper: MessagesWrapper }
        );
        expect(container.textContent).toBe("");
        rerender(
            <WhenFields
                when={{ kind: "count", count: 2, windowSeconds: 600 }}
                triggers={3}
                onChange={() => undefined}
            />
        );
        expect(screen.getByLabelText("How many")).toBeTruthy();
        expect((screen.getByLabelText("Within minutes") as HTMLInputElement).value).toBe("10");
    });

    it("disables everything for a reader who cannot edit", () => {
        render(
            <WhenFields
                when={{ kind: "all", windowSeconds: 300 }}
                triggers={2}
                readOnly
                onChange={() => undefined}
            />,
            { wrapper: MessagesWrapper }
        );
        expect(screen.getByLabelText("Within minutes").matches(":disabled")).toBe(true);
    });
});

describe("a Choose's cases", () => {
    it("adds a case with an empty condition", () => {
        const choose = node("sw", "core.switch", {
            kind: "rules",
            cases: [{ label: "", condition: emptyCondition() }],
            every: false,
            fallback: true
        });
        const setConfig = vi.fn();
        const detail = { draft: draft([node("t", "core.manual"), choose]), others: [] };
        render(
            <FlowNodeFields
                node={choose}
                setConfig={setConfig}
                detail={detail as unknown as AutomationDetail}
            />,
            { wrapper: MessagesWrapper }
        );
        expect(screen.getByText("Case 1")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Add case" }));
        const next = setConfig.mock.calls.at(-1)![0] as { cases: unknown[] };
        expect(next.cases).toHaveLength(2);
        expect(core.CORE_NODE_CONFIGS["core.switch"].safeParse(next).success).toBe(true);
    });
});

describe("ports and passes in the reader's words", () => {
    function Labels({ node: shown, ports }: { node: core.GraphNode; ports: string[] }) {
        const t = useTranslations("automations");
        return <p>{ports.map((port) => portLabel(t, shown, port)).join("|")}</p>;
    }

    it("names a Choose case by its label, lanes by number, and the error port", () => {
        const choose = node("sw", "core.switch", {
            kind: "rules",
            cases: [{ label: "Paid", condition: emptyCondition() }, { condition: emptyCondition() }]
        });
        render(
            <Labels
                node={choose}
                ports={["case1", "case2", "otherwise", "lane2", "error", "timeout", "each", "done"]}
            />,
            { wrapper: MessagesWrapper }
        );
        expect(
            screen.getByText("Paid|Case 2|Otherwise|Path 2|On error|Timed out|Each|Done")
        ).toBeTruthy();
    });

    it("reads loop passes from the iteration path, counted from one", () => {
        expect(passOf("0")).toBeNull();
        expect(passOf("f")).toBeNull();
        expect(passOf("0/each1:0")).toBe("1");
        expect(passOf("0/each1:2/rep:4")).toBe("3.5");
    });
});
