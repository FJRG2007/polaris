// @vitest-environment jsdom

/**
 * The Automations section of a project's settings, as its reader sees it:
 * the empty state, the rules and what starts them, the controls only for
 * somebody who may deploy here, and a failed load that can be tried again.
 *
 * Mounts the real component against stand-ins for its server actions.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeployAutomationView } from "@/lib/deploy/automations";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AutomationsSection } from "@/app/(app)/apps/deploy/settings/automations-section";

const PROJECT = "00000000-0000-4000-8000-000000000001";
const WEB = "00000000-0000-4000-8000-0000000000a1";

const listAutomationsAction = vi.fn();

vi.mock("@/app/(app)/apps/deploy/automation-actions", () => ({
    listAutomationsAction: (projectId: string) => listAutomationsAction(projectId),
    listAutomationRunsAction: vi.fn(async () => ({ runs: [] })),
    saveAutomationAction: vi.fn(async () => ({})),
    setAutomationEnabledAction: vi.fn(async () => ({})),
    rotateAutomationWebhookAction: vi.fn(async () => ({})),
    deleteAutomationAction: vi.fn(async () => ({})),
    runAutomationAction: vi.fn(async () => ({}))
}));

// The real card lives beside the whole settings screen, whose imports reach the
// session; the section only needs the frame.
vi.mock("@/app/(app)/apps/deploy/project-settings", () => ({
    SettingsCard: ({ title, children }: { title: string; children: React.ReactNode }) => (
        <section>
            <h2>{title}</h2>
            {children}
        </section>
    )
}));

afterEach(() => {
    cleanup();
    listAutomationsAction.mockReset();
});

const services = [{ id: WEB, name: "web", environmentId: "env-1", environmentName: "production" }];

function rule(overrides: Partial<DeployAutomationView> = {}): DeployAutomationView {
    return {
        id: "00000000-0000-4000-8000-0000000000b1",
        name: "Restart after a failed deploy",
        enabled: true,
        trigger: "event",
        schedule: null,
        scheduleText: null,
        timezone: "UTC",
        event: "deploy.failed",
        eventApplicationId: WEB,
        actions: [{ type: "restart", applicationId: WEB }],
        hasWebhook: false,
        nextRunAt: null,
        lastRunAt: null,
        lastStatus: null,
        ...overrides
    };
}

function loaded(data: { automations?: DeployAutomationView[]; canEdit?: boolean; canCommand?: boolean }) {
    listAutomationsAction.mockResolvedValue({
        data: { automations: [], services, canEdit: true, canCommand: true, ...data }
    });
}

describe("the Automations section", () => {
    it("says there are none yet, and offers to make one", async () => {
        loaded({});
        render(<AutomationsSection projectId={PROJECT} />, { wrapper: MessagesWrapper });
        expect(await screen.findByText(/No automations yet/)).toBeDefined();
        const create = screen.getByRole("button", { name: "New automation" }) as HTMLButtonElement;
        expect(create.disabled).toBe(false);
    });

    it("shows each rule with what starts it and its controls", async () => {
        loaded({ automations: [rule()] });
        render(<AutomationsSection projectId={PROJECT} />, { wrapper: MessagesWrapper });
        expect(await screen.findByText("Restart after a failed deploy")).toBeDefined();
        expect(screen.getByText(/A deploy failed on web/)).toBeDefined();
        expect(screen.getByRole("button", { name: "Run now" })).toBeDefined();
        expect(screen.getByRole("button", { name: "Edit" })).toBeDefined();
    });

    it("keeps the rules readable and the controls away from somebody who may not deploy", async () => {
        loaded({ automations: [rule()], canEdit: false, canCommand: false });
        render(<AutomationsSection projectId={PROJECT} />, { wrapper: MessagesWrapper });
        expect(await screen.findByText("Restart after a failed deploy")).toBeDefined();
        expect((screen.getByRole("button", { name: "New automation" }) as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByText(/changing them needs the right to deploy/)).toBeDefined();
        expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Run now" })).toBeNull();
    });

    it("opens the editor with its trigger and its actions", async () => {
        loaded({});
        render(<AutomationsSection projectId={PROJECT} />, { wrapper: MessagesWrapper });
        await screen.findByText(/No automations yet/);
        fireEvent.click(screen.getByRole("button", { name: "New automation" }));
        expect(await screen.findByText("When")).toBeDefined();
        expect(screen.getByText("Then")).toBeDefined();
        expect(screen.getByRole("button", { name: /Add action/ })).toBeDefined();
        expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).toBe("true");
    });

    it("offers to try again when the list could not be read", async () => {
        listAutomationsAction.mockResolvedValueOnce({ error: "Could not read the automations" });
        loaded({ automations: [rule()] });
        render(<AutomationsSection projectId={PROJECT} />, { wrapper: MessagesWrapper });
        expect(await screen.findByText("Could not read the automations")).toBeDefined();
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        expect(await screen.findByText("Restart after a failed deploy")).toBeDefined();
    });
});
