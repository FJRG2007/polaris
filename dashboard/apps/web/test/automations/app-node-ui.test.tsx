// @vitest-environment jsdom

/**
 * An app's node in the central editor: drawn by the app's own slot where the app
 * is installed, and greyed with the install action where it is not - named in
 * words either way, with its icon and its ports.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/app/(app)/automations/actions", () => ({ rotateHookAction: vi.fn() }));
const drawn = vi.hoisted(() => ({ slots: [] as unknown[] }));
vi.mock("@/components/app-extensions/installed-client", () => ({
    AppSlotView: ({ slot }: { slot: unknown }) => {
        drawn.slots.push(slot);
        return <div data-testid="app-slot" />;
    }
}));

import * as core from "@polaris/core";
import { MessagesWrapper } from "../setup/i18n";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { AutomationDetail } from "@/lib/automations/service";
import { nodeTitle, portLabel } from "@/app/(app)/automations/shared";
import { NodeFields, configValid } from "@/app/(app)/automations/[id]/node-fields";

afterEach(() => {
    cleanup();
    drawn.slots = [];
});

const node = (type: string, config: unknown = {}) =>
    ({ id: "n1", type, typeVersion: 1, config }) as core.GraphNode;

const detail = (appNodes?: AutomationDetail["appNodes"]) =>
    ({ canEdit: true, draft: core.emptyGraph("UTC"), appNodes }) as unknown as AutomationDetail;

function Words({ type, port }: { type: string; port?: string }) {
    const t = useTranslations("automations");
    return <p>{port ? portLabel(t, { type }, port) : nodeTitle(t, type)}</p>;
}

describe("an app's node in the central editor", () => {
    it("is greyed with the install action where the app is not installed", () => {
        render(
            <NodeFields
                node={node("home.trigger.change", { placeId: "p" })}
                setConfig={vi.fn()}
                detail={detail({})}
                secrets={[]}
                onChanged={vi.fn()}
            />,
            { wrapper: MessagesWrapper }
        );
        expect(screen.getByRole("note").textContent).toContain(
            "Needs an app that is not installed here"
        );
        expect(screen.getByRole("link", { name: "Install the app" })).toHaveProperty(
            "href",
            expect.stringContaining("/apps/marketplace/home")
        );
        expect(drawn.slots).toEqual([]);
    });

    it("is drawn by the app's slot where it is installed, handed the node and the setter", () => {
        const setConfig = vi.fn();
        const bundle = { src: "/api/app-bundles/home/1/client.js", name: "PlacesSlot" };
        render(
            <NodeFields
                node={node("home.action.device", { placeId: "p" })}
                setConfig={setConfig}
                detail={detail({
                    home: { app: "home", kind: "automation-node", props: null, bundle }
                })}
                secrets={[]}
                onChanged={vi.fn()}
            />,
            { wrapper: MessagesWrapper }
        );
        expect(screen.getByTestId("app-slot")).toBeTruthy();
        expect(drawn.slots[0]).toMatchObject({
            app: "home",
            kind: "automation-node",
            bundle,
            props: { node: { type: "home.action.device" }, setConfig, disabled: false }
        });
    });

    it("counts as filled in for the editor; the app checks it on publish", () => {
        expect(configValid(node("home.trigger.time", {}))).toBe(true);
        expect(configValid(node("nope", {}))).toBe(false);
    });

    it("is named in words, even with the app away, and its ports read Then and Else", () => {
        render(
            <>
                <Words type="home.trigger.change" />
                <Words type="home.condition.check" />
                <Words type="home.condition.check" port="else" />
                <Words type="other.trigger.x" />
            </>,
            { wrapper: MessagesWrapper }
        );
        const lines = screen.getAllByRole("paragraph").map((each) => each.textContent);
        expect(lines[0]).toBe("Places: a device changes");
        expect(lines[1]).toBe("Places: check the house");
        expect(lines[2]).toBe("Else");
        expect(lines[3]).not.toBe("");
    });
});
