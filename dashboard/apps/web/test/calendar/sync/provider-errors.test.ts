/**
 * What a refusal from Google or Microsoft means, read from the error bodies
 * they send (`fixtures/provider-errors.json`).
 *
 * The bug this pins: every 401 and 403 used to read as refused credentials, so
 * a Calendar API switched off in the operator's Cloud project showed on every
 * Google account as "Needs reconnecting" - and connecting again can never fix
 * that. A switched-off API, a missing scope, a rate limit and a refused token
 * are four different things to do.
 */

import * as core from "@polaris/core";
import { describe, expect, it } from "vitest";
import {
    SyncAuthError,
    SyncConsentError,
    SyncRefusedError,
    SyncSetupError,
    SyncUnreachableError,
    createGoogleProvider,
    createGraphProvider,
    type Fetcher
} from "@polaris-app/calendar/src/lib/sync";
import recorded from "./fixtures/provider-errors.json";

type Name = keyof typeof recorded;

const ACTIVATION =
    "https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=100000000001";

function answering(name: Name): Fetcher {
    const { status, body } = recorded[name];
    return async () =>
        new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json" }
        });
}

const google = (name: Name) =>
    createGoogleProvider({ accessToken: async () => "token", fetcher: answering(name) });
const graph = (name: Name) =>
    createGraphProvider({ accessToken: async () => "token", fetcher: answering(name) });

const failure = (promise: Promise<unknown>) =>
    promise.then(
        () => null,
        (error: unknown) => error
    );

describe("readGoogleApiError", () => {
    it("reads a switched-off API, with the project and Google's own activation link", () => {
        const { status, body } = recorded.googleServiceDisabled;
        expect(core.readGoogleApiError(status, body)).toEqual({
            kind: "setup",
            service: "calendar-json.googleapis.com",
            serviceTitle: "Google Calendar API",
            project: "100000000001",
            activationUrl: ACTIVATION,
            message: expect.stringContaining("Google Calendar API has not been used")
        });
    });

    it("reads the older body that only has errors[].reason accessNotConfigured", () => {
        const { status, body } = recorded.googleServiceDisabledLegacy;
        expect(core.readGoogleApiError(status, body)).toMatchObject({
            kind: "setup",
            service: null,
            project: null,
            activationUrl: null
        });
    });

    it("never keeps a link that does not point at Google's console", () => {
        const { status, body } = recorded.googleServiceDisabledForeignLink;
        expect(core.readGoogleApiError(status, body)).toMatchObject({
            kind: "setup",
            project: "100000000001",
            activationUrl: null
        });
    });

    it("tells a missing scope, a rate limit, a refused token and anything else apart", () => {
        const kind = (name: Name) =>
            core.readGoogleApiError(recorded[name].status, recorded[name].body).kind;
        expect(kind("googleScopeInsufficient")).toBe("consent");
        expect(kind("googleRateLimit")).toBe("rate");
        expect(kind("googleUnauthenticated")).toBe("auth");
        expect(kind("googleForbiddenWriter")).toBe("other");
        expect(core.readGoogleApiError(429, null).kind).toBe("rate");
        expect(core.readGoogleApiError(401, "not json").kind).toBe("auth");
        expect(core.readGoogleApiError(403, null).kind).toBe("other");
    });
});

describe("readGraphApiError", () => {
    it("reads a missing permission, throttling, a refused token and the rest", () => {
        const kind = (name: Name) =>
            core.readGraphApiError(recorded[name].status, recorded[name].body).kind;
        expect(kind("graphAccessDenied")).toBe("consent");
        expect(kind("graphThrottled")).toBe("rate");
        expect(kind("graphInvalidToken")).toBe("auth");
        expect(kind("graphMailboxNotEnabled")).toBe("other");
    });
});

describe("the Google calendar client", () => {
    it("says a switched-off API needs setting up, not reconnecting", async () => {
        const error = await failure(google("googleServiceDisabled").listCalendars());
        expect(error).toBeInstanceOf(SyncSetupError);
        expect(error).not.toBeInstanceOf(SyncAuthError);
        expect((error as SyncSetupError).setup).toEqual({
            provider: "google",
            service: "calendar-json.googleapis.com",
            project: "100000000001",
            activationUrl: ACTIVATION
        });
        const legacy = await failure(google("googleServiceDisabledLegacy").listCalendars());
        expect((legacy as SyncSetupError).setup.service).toBe("calendar-json.googleapis.com");
    });

    it("asks for consent on a missing scope, retries a rate limit, reconnects on a refused token", async () => {
        expect(await failure(google("googleScopeInsufficient").listCalendars())).toBeInstanceOf(
            SyncConsentError
        );
        expect(await failure(google("googleRateLimit").listCalendars())).toBeInstanceOf(
            SyncUnreachableError
        );
        const refused = await failure(google("googleUnauthenticated").listCalendars());
        expect(refused).toBeInstanceOf(SyncAuthError);
        expect(refused).not.toBeInstanceOf(SyncConsentError);
        const writer = await failure(google("googleForbiddenWriter").listCalendars());
        expect(writer).toBeInstanceOf(SyncRefusedError);
        expect((writer as Error).message).toContain("writer access");
    });
});

describe("the Microsoft Graph calendar client", () => {
    it("asks for consent on a denied permission, retries throttling, reconnects on a refused token", async () => {
        expect(await failure(graph("graphAccessDenied").listCalendars())).toBeInstanceOf(
            SyncConsentError
        );
        expect(await failure(graph("graphThrottled").listCalendars())).toBeInstanceOf(
            SyncUnreachableError
        );
        expect(await failure(graph("graphInvalidToken").listCalendars())).toBeInstanceOf(
            SyncAuthError
        );
        const mailbox = await failure(graph("graphMailboxNotEnabled").listCalendars());
        expect(mailbox).not.toBeInstanceOf(SyncAuthError);
    });
});

describe("a refusal with no body to read", () => {
    it("still offers reconnecting, as a bare 401 or 403 always did", async () => {
        const bare: Fetcher = async () => new Response("", { status: 403 });
        const fromGoogle = createGoogleProvider({
            accessToken: async () => "token",
            fetcher: bare
        });
        const fromGraph = createGraphProvider({ accessToken: async () => "token", fetcher: bare });
        expect(await failure(fromGoogle.listCalendars())).toBeInstanceOf(SyncAuthError);
        expect(await failure(fromGraph.listCalendars())).toBeInstanceOf(SyncAuthError);
    });
});

describe("Google API state and links", () => {
    const at = (iso: string) => new Date(iso);

    it("keeps when an API was first seen off, and forgets the project once it is on", () => {
        const off = core.nextProviderApiState(
            null,
            { state: "disabled", project: "100000000001", activationUrl: ACTIVATION },
            at("2026-10-03T10:00:00Z")
        );
        const still = core.nextProviderApiState(
            off,
            { state: "disabled", project: null, activationUrl: null },
            at("2026-10-03T11:00:00Z")
        );
        expect(still).toMatchObject({
            since: "2026-10-03T10:00:00.000Z",
            checkedAt: "2026-10-03T11:00:00.000Z",
            project: "100000000001",
            activationUrl: ACTIVATION
        });
        const on = core.nextProviderApiState(
            still,
            { state: "enabled" },
            at("2026-10-03T12:00:00Z")
        );
        expect(on).toEqual({
            state: "enabled",
            project: null,
            activationUrl: null,
            since: "2026-10-03T12:00:00.000Z",
            checkedAt: "2026-10-03T12:00:00.000Z"
        });
        expect(core.readProviderApiState(JSON.stringify(on))).toEqual(on);
        expect(core.readProviderApiState("{not json")).toBeNull();
        expect(
            core.readProviderApiState(
                JSON.stringify({ ...off, activationUrl: "https://evil.example.test/" })
            )
        ).toBeNull();
    });

    it("links to Google's own page when it gave one, else the API's page on the project", () => {
        expect(
            core.googleApiEnableUrl("calendar-json.googleapis.com", {
                project: "100000000001",
                activationUrl: ACTIVATION
            })
        ).toBe(ACTIVATION);
        expect(
            core.googleApiEnableUrl("calendar-json.googleapis.com", {
                project: "100000000001",
                activationUrl: null
            })
        ).toBe(
            "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=100000000001"
        );
        expect(core.googleApiLibraryUrl("drive.googleapis.com", "not a project!")).toBe(
            "https://console.cloud.google.com/apis/library/drive.googleapis.com"
        );
        expect(
            core.projectFromGoogleClientId("100000000001-abc123def456.apps.googleusercontent.com")
        ).toBe("100000000001");
        expect(core.projectFromGoogleClientId("not-a-client-id")).toBeNull();
    });
});
