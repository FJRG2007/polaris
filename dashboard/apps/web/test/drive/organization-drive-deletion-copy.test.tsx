// @vitest-environment jsdom

/**
 * The organization settings' Danger card, as somebody about to press it reads
 * it.
 *
 * What is on a company's Drive is a walk of a whole storage away, so the
 * confirmation cannot count it the way it counts spaces and tasks - it can only
 * say that there is one and that it goes too. That sentence is the part
 * somebody about to delete an organization is wrong about if it is missing.
 */

import type { OrgDetail } from "@/lib/orgs/org-service";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SettingsView } from "@/app/(app)/account/organizations/[slug]/settings/settings-view";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("@/components/confirm-dialog", () => ({ useConfirm: () => [async () => true, null] }));
vi.mock("@/app/(app)/account/organizations/actions", () => ({
    changeOrgSlugAction: vi.fn(),
    deleteOrgAction: vi.fn(),
    transferOrgAction: vi.fn(),
    updateOrgAction: vi.fn()
}));
vi.mock("@/app/(app)/account/organizations/[slug]/settings/successor-actions", () => ({
    clearOrgSuccessorAction: vi.fn(),
    setOrgSuccessorAction: vi.fn()
}));
vi.mock("@/app/(app)/account/step-up-actions", () => ({
    proveStepUpAction: vi.fn(),
    sendStepUpCodeAction: vi.fn(),
    stepUpOptionsAction: vi.fn(async () => ({ choices: [] })),
    stepUpRemainingAction: vi.fn()
}));
vi.mock("@/app/(app)/mention-actions", () => ({
    resolveReferencesAction: vi.fn(),
    searchAccountsAction: vi.fn(),
    searchMentionsAction: vi.fn()
}));

afterEach(cleanup);

const ORG: OrgDetail = {
    id: "org1",
    slug: "acme",
    name: "Acme",
    description: "",
    image: null,
    ownerId: "ada",
    ownerName: "Ada Lovelace",
    createdAt: new Date("2026-01-01").toISOString(),
    hasPhoto: false,
    hasBanner: false
};

describe("the organization deletion warning", () => {
    it("names the organization's Drive as part of what deleting takes with it", () => {
        render(
            <SettingsView
                org={ORG}
                isOwner={false}
                canManage={false}
                canDelete
                candidates={[]}
                successor={null}
                impact={{ spaces: 2, tasks: 5, projects: 0, drive: true }}
            />
        );

        expect(screen.getByText(/Its Drive and everything on it go with it\./)).toBeTruthy();
    });

    it("says nothing about a Drive for an organization that never had one", () => {
        render(
            <SettingsView
                org={ORG}
                isOwner={false}
                canManage={false}
                canDelete
                candidates={[]}
                successor={null}
                impact={{ spaces: 2, tasks: 5, projects: 0, drive: false }}
            />
        );

        expect(screen.queryByText(/Its Drive/)).toBeNull();
    });
});
