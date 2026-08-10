/**
 * The account-security alert, and the audit trail it hangs off.
 *
 * Two things are worth pinning down. The alert has to fire for the actions that
 * change how an account is protected, because that is the one warning somebody
 * gets that their account is being taken over. And it must not fire for the rest
 * of the log - a file uploaded, a container restarted - because an alert that
 * cries at everything is one people turn off, and this one is meant to be the
 * alert they leave on.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const notify = vi.fn(async () => {});

vi.mock("../../src/lib/notifications/dispatch", () => ({ notify: (input: unknown) => notify(input as never) }));

const { notifySecurityChange } = await import("../../src/lib/notifications/security-events");

const USER = "user-1";

/** The single alert raised, or null when nothing was. */
function raised(): { event: string; title: string; href: string } | null {
    const call = notify.mock.calls.at(0)?.[0] as unknown as { event: string; title: string; href: string };
    return call ?? null;
}

beforeEach(() => {
    notify.mockClear();
});

describe("telling an account its protection changed", () => {
    it("raises the critical security event, pointed at the screen it was done on", async () => {
        await notifySecurityChange(USER, "account.password.changed");
        expect(raised()).toMatchObject({ event: "account.security", href: "/account/security" });
        expect(raised()?.title).toContain("password");
    });

    it("covers the credentials that are not the password", async () => {
        for (const action of [
            "account.passkey.added",
            "account.passkey.removed",
            "account.2fa.methods-updated",
            "account.phone.set",
            "account.api-key.created",
            "account.email.primary-changed",
            "account.signin-rules.updated"
        ]) {
            notify.mockClear();
            await notifySecurityChange(USER, action);
            expect(raised(), action).not.toBeNull();
        }
    });

    it("says nothing about the ordinary log", async () => {
        for (const action of ["drive.upload", "deploy.app.deploy", "apps.install", "account.signin"]) {
            await notifySecurityChange(USER, action);
        }
        expect(notify).not.toHaveBeenCalled();
    });

    it("says nothing when nothing signed in did it", async () => {
        // Background work carries no actor, and there is no account to tell.
        await notifySecurityChange(null, "account.password.changed");
        expect(notify).not.toHaveBeenCalled();
    });
});
