// @vitest-environment jsdom

/**
 * The project canvas mounted for real: every service is a card a keyboard can
 * reach and open, pointing at one lights the lines into it, a link can be
 * removed by name, and the zoom controls move the board between its limits.
 * The geometry under it is covered in canvas-geometry.test.ts; this is what
 * somebody sees and operates. There is no browser here, so layout (where the
 * cards land on screen) is not what is asserted.
 */

import type { ReactNode } from "react";
import { MessagesWrapper } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProjectSummary } from "@/app/(app)/apps/deploy/deploy-view";

const saveLayoutAction = vi.fn(async (_input: unknown) => ({}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: vi.fn(), push: vi.fn() })
}));

vi.mock("@/app/(app)/apps/deploy/actions", () => ({
    saveLayoutAction: (input: unknown) => saveLayoutAction(input),
    duplicateApplicationAction: vi.fn(async () => ({}))
}));

vi.mock("@/app/(app)/apps/deploy/project-actions", () => ({
    stageDatabaseDeleteAction: vi.fn(async () => ({})),
    stageServiceDeleteAction: vi.fn(async () => ({}))
}));

// The dialogs the canvas can open each pull in their own server actions and the
// session module behind them; none of them is open in these tests.
vi.mock("@/app/(app)/apps/deploy/volume-form", () => ({ NewVolumeDialog: () => null }));
vi.mock("@/app/(app)/apps/deploy/volume-detail", () => ({ VolumeDetailDialog: () => null }));
vi.mock("@/app/(app)/apps/deploy/database-panel", () => ({ DatabaseManageDialog: () => null }));

// `deploy-view.tsx` holds the whole Deploy service panel, which at import
// time reaches every Deploy server action. The canvas uses a handful of small
// presentational pieces from it, reproduced here.
vi.mock("@/app/(app)/apps/deploy/deploy-view", () => ({
    NewServiceDialog: () => null,
    SERVICE_TYPES: [],
    ServiceIcon: () => <span />,
    runStateLabel: (app: { runState: string }) => ({
        label: app.runState,
        hint: null,
        tone: app.runState === "deploying" ? "warning" : "success"
    }),
    serviceKindOf: () => "github"
}));

vi.mock("@/components/logos", () => ({ IntegrationLogo: () => null }));
vi.mock("@/components/db-engine-icon", () => ({ DbEngineIcon: () => null }));

const { DeployCanvas } = await import("@/app/(app)/apps/deploy/deploy-canvas");

// What jsdom does not implement and Radix's context menu calls.
beforeAll(() => {
    Object.assign(Element.prototype, {
        hasPointerCapture: () => false,
        setPointerCapture: () => undefined,
        releasePointerCapture: () => undefined,
        scrollIntoView: () => undefined
    });
});

afterEach(() => {
    cleanup();
    saveLayoutAction.mockClear();
});

type Environment = ProjectSummary["environments"][number];

function app(id: string, name: string, runState = "running"): Environment["applications"][number] {
    return {
        id,
        name,
        sourceType: "github",
        runState,
        deployStatus: null,
        elsewhere: [],
        domains: [],
        volumes: []
    } as unknown as Environment["applications"][number];
}

function environment(overrides: Partial<Environment> = {}): Environment {
    return {
        id: "env-1",
        name: "production",
        isDefault: true,
        layout: JSON.stringify({
            pos: { api: { x: 0, y: 0 }, web: { x: 400, y: 0 }, worker: { x: 0, y: 300 } },
            links: [{ source: "web", target: "api" }]
        }),
        referenceEdges: [],
        applications: [app("api", "api"), app("web", "web"), app("worker", "worker", "deploying")],
        databases: [],
        ...overrides
    } as Environment;
}

function mount(node: ReactNode) {
    return render(node, { wrapper: MessagesWrapper });
}

describe("the project canvas", () => {
    it("makes every service a card a keyboard can reach, named with its state", () => {
        mount(<DeployCanvas environment={environment()} canManage />);
        expect(screen.getByRole("button", { name: "Open api (Online)" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Open worker (deploying)" })).toBeTruthy();
    });

    it("opens a service from the keyboard", async () => {
        const onOpenService = vi.fn();
        mount(<DeployCanvas environment={environment()} canManage onOpenService={onOpenService} />);
        screen.getByRole("button", { name: "Open web (Online)" }).focus();
        await userEvent.keyboard("{Enter}");
        expect(onOpenService).toHaveBeenCalledWith(expect.objectContaining({ id: "web" }));
    });

    it("lights the cards joined to the one being pointed at", async () => {
        mount(<DeployCanvas environment={environment()} canManage />);
        const web = screen.getByRole("button", { name: "Open web (Online)" });
        const api = screen.getByRole("button", { name: "Open api (Online)" });
        const worker = screen.getByRole("button", { name: "Open worker (deploying)" });
        expect(api.className).not.toContain("border-primary/50");
        await userEvent.hover(web);
        expect(api.className).toContain("border-primary/50");
        expect(worker.className).not.toContain("border-primary/50");
        await userEvent.unhover(web);
        expect(api.className).not.toContain("border-primary/50");
    });

    it("rings a deploying service so it stands out from the rest", () => {
        mount(<DeployCanvas environment={environment()} canManage />);
        const worker = screen.getByRole("button", { name: "Open worker (deploying)" });
        expect(worker.className).toContain("border-warning-edge");
        // Its chip sends a halo out from the dot; a settled service's does not.
        expect(worker.querySelector(".animate-ping")).not.toBeNull();
        const api = screen.getByRole("button", { name: "Open api (Online)" });
        expect(api.querySelector(".animate-ping")).toBeNull();
        expect(api.querySelector(".bg-success-soft")?.textContent).toBe("Online");
    });

    it("keeps the lines into a deploying service moving", () => {
        const { container } = mount(
            <DeployCanvas
                environment={environment({
                    layout: JSON.stringify({
                        pos: {
                            api: { x: 0, y: 0 },
                            web: { x: 400, y: 0 },
                            worker: { x: 0, y: 300 }
                        },
                        links: [
                            { source: "web", target: "api" },
                            { source: "worker", target: "api" }
                        ]
                    })
                })}
                canManage
            />
        );
        // One line touches the deploying worker; the web-api line is settled.
        expect(container.querySelectorAll(".deploy-edge-flow")).toHaveLength(1);
    });

    it("names both ends of a link on its remove control, and removing it saves the layout", async () => {
        mount(<DeployCanvas environment={environment()} canManage />);
        await userEvent.click(
            screen.getByRole("button", { name: "Remove the link between web and api" })
        );
        expect(saveLayoutAction).toHaveBeenCalledTimes(1);
        const saved = JSON.parse(
            (saveLayoutAction.mock.calls[0]![0] as { layout: string }).layout
        ) as { links: unknown[] };
        expect(saved.links).toEqual([]);
        expect(
            screen.queryByRole("button", { name: "Remove the link between web and api" })
        ).toBeNull();
    });

    it("offers no remove control to somebody who cannot change the project", () => {
        mount(<DeployCanvas environment={environment()} canManage={false} />);
        expect(screen.queryByRole("button", { name: /Remove the link/ })).toBeNull();
        // Reading it is still possible: the cards and the zoom are there.
        expect(screen.getByRole("button", { name: "Open api (Online)" })).toBeTruthy();
        expect(screen.getByRole("toolbar", { name: "Zoom" })).toBeTruthy();
    });

    it("zooms between its limits and back to 100%", async () => {
        mount(<DeployCanvas environment={environment()} canManage />);
        const zoomIn = screen.getByRole("button", { name: "Zoom in" });
        const zoomOut = screen.getByRole("button", { name: "Zoom out" });
        const reset = screen.getByRole("button", { name: "Reset to 100%" });
        expect(reset.textContent).toBe("100%");

        await userEvent.click(zoomIn);
        expect(reset.textContent).toBe("120%");
        for (let step = 0; step < 6; step += 1) await userEvent.click(zoomIn);
        expect(reset.textContent).toBe("150%");
        expect(zoomIn).toHaveProperty("disabled", true);

        for (let step = 0; step < 12; step += 1) await userEvent.click(zoomOut);
        expect(reset.textContent).toBe("40%");
        expect(zoomOut).toHaveProperty("disabled", true);

        await userEvent.click(reset);
        expect(reset.textContent).toBe("100%");
        // Zoom is how the reader looks at the board, not part of the layout.
        expect(saveLayoutAction).not.toHaveBeenCalled();
    });

    it("offers to add the first service from an empty board", () => {
        mount(
            <DeployCanvas environment={environment({ applications: [], layout: "{}" })} canManage />
        );
        expect(screen.getByText("Nothing deployed yet")).toBeTruthy();
        expect(screen.getByRole("button", { name: /New service/ })).toBeTruthy();
    });

    it("does not offer to add a service to somebody who cannot", () => {
        mount(
            <DeployCanvas
                environment={environment({ applications: [], layout: "{}" })}
                canManage={false}
            />
        );
        expect(screen.queryByRole("button", { name: /New service/ })).toBeNull();
    });
});
