// @vitest-environment jsdom

/**
 * The command-line and extension approval screens, drawn with the shared
 * consent card. What is pinned is what the decision rests on: the code to
 * match against the other device, the account it would act for, where the
 * request came from, and - for the CLI - what the key will be able to do,
 * with each flow's own Allow / Deny wording.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
    useSearchParams: () => new URLSearchParams("code=BCDFGHJK")
}));

const answerCliSignInAction = vi.fn(async () => ({}) as { error?: string });
vi.mock("@/app/(app)/account/cli/actions", () => ({
    describeCliSignInAction: vi.fn(async () => ({
        pending: {
            userCode: "BCDFGHJK",
            device: "build-box",
            clientVersion: "0.1.0",
            os: "Linux",
            scopes: ["deploy.read", "deploy.manage"],
            requestIp: "203.0.113.7",
            host: "polaris.example.com",
            requestedAt: "2026-09-14T10:00:00.000Z",
            expiresAt: "2026-09-14T10:05:00.000Z"
        }
    })),
    answerCliSignInAction: (...args: unknown[]) => answerCliSignInAction(...args)
}));

vi.mock("@/app/(app)/account/extension/actions", () => ({
    describeConnectionAction: vi.fn(async () => ({
        pending: {
            userCode: "BCDFGHJK",
            device: "Brave on Windows",
            browser: "Brave",
            os: "Windows",
            requestIp: "198.51.100.4",
            host: "polaris.example.com",
            requestedAt: "2026-09-14T10:00:00.000Z",
            expiresAt: "2026-09-14T10:05:00.000Z"
        }
    })),
    answerConnectionAction: vi.fn(async () => ({}))
}));

const { CliApproveView } = await import("@/app/(app)/account/cli/cli-approve-view");
const { ExtensionConnectView } = await import(
    "@/app/(app)/account/extension/extension-connect-view"
);

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe("the command-line approval", () => {
    it("shows the code, the account, the facts and what the key can do", async () => {
        render(<CliApproveView account="Signed in as Ada" />, { wrapper: MessagesWrapper });
        expect(await screen.findByText("Sign in build-box")).toBeTruthy();
        expect(screen.getByText("Code BCDF-GHJK")).toBeTruthy();
        expect(screen.getByText("Signed in as Ada")).toBeTruthy();
        expect(screen.getByText("203.0.113.7")).toBeTruthy();
        expect(screen.getByText("See your apps, their deployments and their logs")).toBeTruthy();
        expect(screen.getByText("Deploy, roll back, restart and stop your apps")).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: "Turn it away" }));
        expect(await screen.findByText("Turned away.")).toBeTruthy();
        expect(answerCliSignInAction).toHaveBeenCalledWith({
            userCode: "BCDFGHJK",
            approve: false
        });
    });
});

describe("the extension approval", () => {
    it("shows the browser it came from and its own wording", async () => {
        render(<ExtensionConnectView account="Signed in as Ada" />, { wrapper: MessagesWrapper });
        expect(await screen.findByText("Connect Brave on Windows to Polaris")).toBeTruthy();
        expect(screen.getByText("Code BCDF-GHJK")).toBeTruthy();
        expect(screen.getByText("Brave on Windows", { selector: "dd" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Connect it" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Turn it away" })).toBeTruthy();
    });
});
