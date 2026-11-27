// @vitest-environment jsdom

/**
 * A host action this machine's Polaris is too old for (Restart now on an
 * install not updated since) says the machine needs a Polaris update and
 * offers it to an administrator; anybody else is told to ask one. Every other
 * failure is only its words.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { securityCatalogs } from "@polaris-app/security-scans/messages";
import {
    CanUpdateContext,
    ErrorLine,
    UPDATES_HREF
} from "@polaris-app/security-scans/src/screens/error-line";

const t = securityCatalogs.translator("en-US", "security");

function show(code: string, canUpdate: boolean) {
    return render(
        <CanUpdateContext.Provider value={canUpdate}>
            <ErrorLine t={t} code={code} />
        </CanUpdateContext.Provider>
    );
}

describe("ErrorLine", () => {
    afterEach(cleanup);

    it("offers the Polaris update to an administrator", () => {
        show("daemonOutdated", true);
        expect(screen.getByText(t("errors.daemonOutdated"))).toBeTruthy();
        const link = screen.getByRole("link", { name: t("errors.updatePolaris") });
        expect(link.getAttribute("href")).toBe(UPDATES_HREF);
        expect(screen.queryByText(t("errors.updatesFailed"))).toBeNull();
    });

    it("tells anybody else to ask an administrator", () => {
        show("daemonOutdated", false);
        expect(screen.getByText(t("errors.askToUpdate"))).toBeTruthy();
        expect(screen.queryByRole("link")).toBeNull();
    });

    it("keeps any other failure to its words", () => {
        show("updatesFailed", true);
        expect(screen.getByText(t("errors.updatesFailed"))).toBeTruthy();
        expect(screen.queryByRole("link")).toBeNull();
    });

    it("words an unknown code as the generic failure", () => {
        show("somethingNew", true);
        expect(screen.getByText(t("errors.failed"))).toBeTruthy();
    });
});
