/**
 * What is said above a service's deployments, and what is said at the top of a
 * project: a failed last deploy with the line that says why, and the summary of
 * where an environment answers and how its last deploy went.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DeploymentSummary } from "@/lib/deploy-service";
import type { EnvironmentGlance } from "@/lib/deploy/project-glance";

vi.mock("@/app/(app)/apps/deploy/glance-actions", () => ({
    deployFreshnessAction: async () => null,
    projectGlanceAction: async () => null
}));
// The likely cause under a failed deploy asks the server once it mounts, which a
// static render never does.
vi.mock("@/app/(app)/apps/deploy/fix-actions", () => ({
    deploymentDiagnosisAction: async () => ({ diagnosis: null }),
    applyDeployFixAction: async () => ({})
}));
vi.mock("@/components/relative-time", () => ({
    RelativeTime: ({ iso }: { iso: string }) => `relative:${iso}`
}));

const { DeployCallouts } = await import("@/app/(app)/apps/deploy/deploy-callouts");
const { ProjectGlanceBar } = await import("@/app/(app)/apps/deploy/project-glance-bar");
const { TabAttentionDot, tabAttention } = await import("@/app/(app)/apps/deploy/attention-dot");

function deployment(overrides: Partial<DeploymentSummary>): DeploymentSummary {
    return {
        id: "dep",
        status: "running",
        error: null,
        createdAt: "2026-09-10T10:00:00.000Z",
        isCurrent: false,
        commitMessage: null,
        commitSha: null,
        authorName: null,
        authorAvatarUrl: null,
        commitUrl: null,
        hostname: null,
        rollbackable: false,
        imageKept: false,
        pinned: false,
        rollbackOfId: null,
        durationMs: null,
        ...overrides
    };
}

function callouts(items: DeploymentSummary[], canDeploy = true): string {
    return renderToStaticMarkup(
        <DeployCallouts
            applicationId="app"
            items={items}
            canDeploy={canDeploy}
            busy={false}
            onDeploy={() => undefined}
            onViewLog={() => undefined}
        />
    );
}

describe("the callouts over a service's deployments", () => {
    it("says the last deploy failed with the first line of its error, and offers the log and a redeploy", () => {
        const html = callouts([
            deployment({
                id: "new",
                status: "failed",
                error: "\n  npm ERR! missing script: build\nat line 2"
            }),
            deployment({ id: "old", isCurrent: true })
        ]);
        expect(html).toContain("Action required");
        expect(html).toContain("npm ERR! missing script: build");
        expect(html).not.toContain("at line 2");
        expect(html).toContain("The release before it is still live.");
        expect(html).toContain("View log");
        expect(html).toContain("Redeploy");
    });

    it("keeps the log but not the redeploy for somebody who cannot deploy", () => {
        const html = callouts([deployment({ status: "failed", error: "boom" })], false);
        expect(html).toContain("View log");
        expect(html).not.toContain("Redeploy");
    });

    it("says nothing when the newest deploy went through", () => {
        expect(
            callouts([deployment({ isCurrent: true }), deployment({ id: "x", status: "failed" })])
        ).toBe("");
    });
});

const GLANCE: EnvironmentGlance = {
    addresses: [
        {
            id: "a",
            hostname: "web-1.example.test",
            kind: "auto",
            enabled: true,
            healthStatus: "up",
            applicationId: "web",
            service: "Web"
        },
        {
            id: "b",
            hostname: "shop.example.test",
            kind: "custom",
            enabled: true,
            healthStatus: "down",
            applicationId: "web",
            service: "Web"
        },
        {
            id: "c",
            hostname: "off.example.test",
            kind: "custom",
            enabled: false,
            applicationId: "api",
            service: "API"
        }
    ],
    lastDeploy: {
        applicationId: "api",
        service: "API",
        status: "failed",
        createdAt: "2026-09-10T10:00:00.000Z"
    },
    attention: [
        { applicationId: "api", service: "API", reasons: ["last deploy failed"] },
        { applicationId: "web", service: "Web", reasons: ["an address is down"] }
    ]
};

describe("the project summary line", () => {
    const render = (glance: EnvironmentGlance | undefined) =>
        renderToStaticMarkup(
            <ProjectGlanceBar
                environmentId="prod"
                glance={glance}
                serviceHref={(id) => `/p?service=${id}`}
            />
        );

    it("shows the most stable address first and offers the others, never a disabled one", () => {
        const html = render(GLANCE);
        expect(html.indexOf("shop.example.test")).toBeLessThan(html.indexOf("Switch address"));
        expect(html).toContain('href="https://shop.example.test"');
        expect(html).toContain("+1");
        expect(html).not.toContain("off.example.test");
    });

    it("links the last deploy and the services that need a look to their panels", () => {
        const html = render(GLANCE);
        expect(html).toContain("Last deploy");
        expect(html).toContain("failed");
        expect(html).toContain('href="/p?service=api"');
        expect(html).toContain("2 services need a look");
    });

    it("says so when there is no address and no deploy yet", () => {
        const html = render({ addresses: [], lastDeploy: null, attention: [] });
        expect(html).toContain("No address yet");
        expect(html).toContain("Not deployed yet");
        expect(html).not.toContain("need a look");
    });
});

describe("the attention dots", () => {
    it("names the tab each problem belongs to", () => {
        expect(tabAttention({ deployFailed: true, domainDown: true, cronFailing: false })).toEqual({
            Deployments: "The last deploy failed",
            Settings: "An address is down"
        });
        expect(tabAttention(undefined)).toEqual({});
    });

    it("is named by its reason, not only its colour", () => {
        const html = renderToStaticMarkup(<TabAttentionDot label="A scheduled job is failing" />);
        expect(html).toContain('aria-label="A scheduled job is failing"');
        expect(html).toContain("bg-danger-solid");
    });
});
