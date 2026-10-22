// @vitest-environment jsdom

/**
 * A release's vulnerability warning as the Deployments tab draws it: the chip,
 * the finding with its advisory, and "Deploy anyway" on a release the check
 * held back - asked in the app's own dialog, never the browser's, and only for
 * a reader who may deploy. The findings are fixture data.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const deployAnyway = vi.fn();
const allowed = vi.fn((_capability: string) => true);

vi.mock("@/app/(app)/apps/deploy/actions", () => ({
    deployAnywayAction: (id: string) => deployAnyway(id),
    listDeploymentsAction: vi.fn()
}));
vi.mock("@/app/(app)/apps/deploy/access-context", () => ({
    useProjectCan: () => (capability: string) => allowed(capability)
}));

import { SecurityChip, SecurityNote } from "@/app/(app)/apps/deploy/deployment-security";

afterEach(() => {
    cleanup();
    deployAnyway.mockReset();
    allowed.mockReset();
    allowed.mockImplementation(() => true);
});

type Row = Parameters<typeof SecurityNote>[0]["deployment"];

function row(overrides: Partial<Row> = {}): Row {
    return {
        id: "0190f7a2-5b1c-7d3e-8f00-1234567890ab",
        status: "failed",
        security: {
            count: 2,
            id: "CVE-0000-0004",
            package: "fixture-node 22.0.0",
            fixedIn: "22.0.1",
            url: "https://nvd.nist.gov/vuln/detail/CVE-0000-0004",
            refused: true
        },
        securityOverrideAt: null,
        canDeployAnyway: true,
        ...overrides
    } as Row;
}

async function confirmInDialog() {
    fireEvent.click(screen.getByRole("button", { name: "Deploy anyway" }));
    expect(await screen.findByText("Deploy this release anyway?")).toBeDefined();
    const buttons = screen.getAllByRole("button", { name: "Deploy anyway" });
    fireEvent.click(buttons[buttons.length - 1]!);
}

describe("a release's vulnerability warning", () => {
    it("draws nothing for a release the check found nothing in", () => {
        const clean = row({ security: null, canDeployAnyway: false });
        const { container } = render(
            <>
                <SecurityChip deployment={clean} />
                <SecurityNote deployment={clean} onDeployStarted={vi.fn()} />
            </>,
            { wrapper: MessagesWrapper }
        );
        expect(container.textContent).toBe("");
    });

    it("names the finding, links its advisory and says the release was held back", () => {
        render(
            <>
                <SecurityChip deployment={row()} />
                <SecurityNote deployment={row()} onDeployStarted={vi.fn()} />
            </>,
            { wrapper: MessagesWrapper }
        );
        expect(screen.getByText("Held back")).toBeDefined();
        expect(screen.getByText("2 critical vulnerabilities with a known fix:")).toBeDefined();
        const link = screen.getByRole("link", { name: /CVE-0000-0004/ });
        expect(link.getAttribute("href")).toBe("https://nvd.nist.gov/vuln/detail/CVE-0000-0004");
        expect(screen.getByText("in fixture-node 22.0.0, fixed in 22.0.1")).toBeDefined();
        expect(screen.getByText(/This service blocks such releases/)).toBeDefined();
    });

    it("only warns on a release that went live, with no way past to offer", () => {
        const live = row({
            status: "running",
            canDeployAnyway: false,
            security: { ...row().security!, refused: false }
        });
        render(
            <>
                <SecurityChip deployment={live} />
                <SecurityNote deployment={live} onDeployStarted={vi.fn()} />
            </>,
            { wrapper: MessagesWrapper }
        );
        expect(screen.getByText("Vulnerable")).toBeDefined();
        expect(screen.queryByRole("button", { name: "Deploy anyway" })).toBeNull();
    });

    it("asks in a dialog before deploying anyway, and follows the new deployment", async () => {
        deployAnyway.mockResolvedValue({ deploymentId: "new-deployment" });
        const started = vi.fn();
        render(<SecurityNote deployment={row()} onDeployStarted={started} />, {
            wrapper: MessagesWrapper
        });
        fireEvent.click(screen.getByRole("button", { name: "Deploy anyway" }));
        expect(await screen.findByText("Deploy this release anyway?")).toBeDefined();
        expect(deployAnyway).not.toHaveBeenCalled();
        const buttons = screen.getAllByRole("button", { name: "Deploy anyway" });
        fireEvent.click(buttons[buttons.length - 1]!);
        await waitFor(() => expect(deployAnyway).toHaveBeenCalledWith(row().id));
        await waitFor(() => expect(started).toHaveBeenCalledWith("new-deployment"));
    });

    it("says why when the server will not deploy it", async () => {
        deployAnyway.mockResolvedValue({ error: "Could not deploy that release anyway" });
        render(<SecurityNote deployment={row()} onDeployStarted={vi.fn()} />, {
            wrapper: MessagesWrapper
        });
        await confirmInDialog();
        expect(await screen.findByText("Could not deploy that release anyway")).toBeDefined();
    });

    it("offers no way past to a reader who may not deploy", () => {
        allowed.mockImplementation(() => false);
        render(<SecurityNote deployment={row()} onDeployStarted={vi.fn()} />, {
            wrapper: MessagesWrapper
        });
        expect(screen.queryByRole("button", { name: "Deploy anyway" })).toBeNull();
    });
});
