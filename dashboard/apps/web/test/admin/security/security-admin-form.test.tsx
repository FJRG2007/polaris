// @vitest-environment jsdom

/**
 * The instance security form: turning the second step off goes through the
 * risk dialog and saves with the risk accepted, a standing note says so while it
 * is off, and the phone requirement cannot be switched on while no WhatsApp
 * sender could confirm a number - it says why and links to where that is fixed.
 */

import { MessagesWrapper } from "../../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INSTANCE_SECURITY_DEFAULTS } from "@polaris/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
const save = vi.hoisted(() => vi.fn(async (_input: unknown): Promise<{ error?: string; ok?: string }> => ({ ok: "Saved." })));
vi.mock("@/app/(app)/admin/security/actions", () => ({ saveInstanceSecurityAction: save }));

const { SecurityAdmin } = await import("@/app/(app)/admin/security/security-admin");

afterEach(() => {
    cleanup();
    save.mockClear();
});

function draw(policy = INSTANCE_SECURITY_DEFAULTS, phoneReady = true) {
    return render(
        <MessagesWrapper>
            <SecurityAdmin policy={policy} mailReady phoneReady={phoneReady} />
        </MessagesWrapper>
    );
}

const toggle = (name: string) => screen.getByRole("switch", { name }) as HTMLButtonElement;

describe("turning the second step off", () => {
    it("asks for the risk to be accepted, then saves with it", async () => {
        draw();
        fireEvent.click(toggle("Require a second step to sign in"));
        expect(screen.getByText("Let accounts in with only a password?")).toBeTruthy();
        expect(save).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("checkbox", { name: /I accept the risk/ }));
        fireEvent.click(screen.getByRole("button", { name: "Accept and save" }));
        await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
        expect(save.mock.calls[0]![0]).toMatchObject({ requireSecondFactor: false, acceptRisk: true });
    });

    it("changes nothing when the administrator keeps it", () => {
        draw();
        fireEvent.click(toggle("Require a second step to sign in"));
        fireEvent.click(screen.getByRole("button", { name: "Keep requiring it" }));
        expect(toggle("Require a second step to sign in").getAttribute("aria-checked")).toBe("true");
        expect(save).not.toHaveBeenCalled();
    });

    it("says an administrator accepted the risk while it is off", () => {
        draw({ ...INSTANCE_SECURITY_DEFAULTS, requireSecondFactor: false });
        expect(screen.getByText(/An administrator accepted that risk/)).toBeTruthy();
    });
});

describe("requiring a phone", () => {
    it("is disabled with the reason and the way to fix it when no sender is connected", () => {
        draw(INSTANCE_SECURITY_DEFAULTS, false);
        expect(toggle("Require a phone number on every account").disabled).toBe(true);
        expect(screen.getByText(/WhatsApp or SMS code, and neither is set up/)).toBeTruthy();
        expect(screen.getByRole("link", { name: "Set up WhatsApp codes" }).getAttribute("href")).toBe(
            "/admin/integrations/messaging"
        );
    });

    it("can still be turned off while the sender is down", () => {
        draw({ ...INSTANCE_SECURITY_DEFAULTS, requirePhone: true }, false);
        expect(toggle("Require a phone number on every account").disabled).toBe(false);
    });

    it("saves the requirement", async () => {
        draw();
        fireEvent.click(toggle("Require a phone number on every account"));
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
        expect(save.mock.calls[0]![0]).toMatchObject({ requirePhone: true, acceptRisk: false });
    });
});
