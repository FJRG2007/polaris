import { describe, expect, it } from "vitest";
import * as sync from "./environment-sync.js";
import { PROJECT_CAPABILITIES, type ProjectCapability } from "./schemas/project-access.js";

const SOURCE_ID = "00000000-0000-4000-8000-000000000001";
const TARGET_ID = "00000000-0000-4000-8000-000000000002";

function settings(overrides: Partial<Record<sync.SyncSettingField, string | null>> = {}) {
    const out = {} as Record<sync.SyncSettingField, sync.SyncField>;
    for (const field of sync.SYNC_SETTING_FIELDS) {
        const value = field in overrides ? (overrides[field] ?? null) : `${field}-same`;
        out[field] = { value, display: value === null ? null : `shown:${value}` };
    }
    return out;
}

function service(slug: string, extra: Partial<sync.SyncService> = {}): sync.SyncService {
    return {
        id: `${slug}-id`,
        slug,
        name: slug.toUpperCase(),
        settings: settings(),
        variables: [],
        volumes: [],
        ...extra
    };
}

function snapshot(services: sync.SyncService[], extra: Partial<sync.SyncSnapshot> = {}): sync.SyncSnapshot {
    return { services, sharedVariables: [], networkMode: "shared", ...extra };
}

const EVERYTHING: readonly ProjectCapability[] = PROJECT_CAPABILITIES;

describe("sync.diffEnvironments", () => {
    it("answers nothing for two equal environments, so a second apply is a no-op", () => {
        const side = snapshot([
            service("api", {
                variables: [{ key: "TOKEN", fingerprint: "f1", secret: true }],
                volumes: [{ name: "data", mountPath: "/data" }]
            })
        ]);
        const diff = sync.diffEnvironments(side, side);
        expect(diff.items).toEqual([]);
        expect(diff.services).toEqual([]);
    });

    it("tags services new, edited and removed, the way the canvas does", () => {
        const source = snapshot([service("api", { settings: settings({ replicas: "3" }) }), service("web")]);
        const target = snapshot([service("api"), service("worker")]);
        const diff = sync.diffEnvironments(source, target);
        expect(diff.services).toEqual([
            { slug: "api", name: "API", status: "edited" },
            { slug: "web", name: "WEB", status: "new" },
            { slug: "worker", name: "WORKER", status: "removed" }
        ]);
        const ids = diff.items.map((item) => item.id);
        expect(ids).toEqual(["setting:api:replicas", "add:web", "remove:worker"]);
        // A removal is never picked for the reader.
        expect(diff.items.find((item) => item.id === "remove:worker")?.recommended).toBe(false);
        expect(diff.items.find((item) => item.id === "add:web")?.recommended).toBe(true);
    });

    it("shows a setting by its display form, never the compared value", () => {
        const source = snapshot([
            service("api", { settings: settings({ source: "https://user:hunter2@git/x" }) })
        ]);
        const sourceDisplay = {
            ...source,
            services: [
                {
                    ...source.services[0]!,
                    settings: {
                        ...source.services[0]!.settings,
                        source: { value: "https://user:hunter2@git/x", display: "https://git/x" }
                    }
                }
            ]
        };
        const diff = sync.diffEnvironments(sourceDisplay, snapshot([service("api")]));
        expect(JSON.stringify(diff)).not.toContain("hunter2");
        expect(diff.items[0]).toMatchObject({ field: "source", to: "https://git/x" });
    });

    it("masks variables: keys and whether they changed, never a value or fingerprint", () => {
        const source = snapshot(
            [
                service("api", {
                    variables: [
                        { key: "A", fingerprint: "same", secret: false },
                        { key: "B", fingerprint: "new-secret-digest", secret: true },
                        { key: "C", fingerprint: "c", secret: false }
                    ]
                })
            ],
            { sharedVariables: [{ key: "SHARED", fingerprint: "s2", secret: true }] }
        );
        const target = snapshot(
            [
                service("api", {
                    variables: [
                        { key: "A", fingerprint: "same", secret: false },
                        { key: "B", fingerprint: "old-secret-digest", secret: true },
                        { key: "OLD", fingerprint: "o", secret: false }
                    ]
                })
            ],
            { sharedVariables: [{ key: "SHARED", fingerprint: "s1", secret: true }] }
        );
        const diff = sync.diffEnvironments(source, target);
        expect(diff.items.map((item) => [item.id, item.change])).toEqual([
            ["var:api:B", "changed"],
            ["var:api:C", "added"],
            ["var:api:OLD", "removed"],
            ["shared:SHARED", "changed"]
        ]);
        const text = JSON.stringify(diff);
        expect(text).not.toContain("digest");
        expect(text).not.toContain("s1");
        expect(diff.items.find((item) => item.key === "B")?.secret).toBe(true);
    });

    it("never copies domains and never removes a volume", () => {
        const source = snapshot([service("api", { volumes: [{ name: "cache", mountPath: "/c" }] })]);
        const target = snapshot([
            service("api", {
                volumes: [
                    { name: "cache", mountPath: "/old" },
                    { name: "uploads", mountPath: "/u" }
                ]
            })
        ]);
        const diff = sync.diffEnvironments(source, target);
        expect(diff.items.map((item) => [item.id, item.change])).toEqual([
            ["volume:api:cache", "changed"]
        ]);
        expect(diff.keptVolumes).toEqual([{ service: "API", name: "uploads" }]);
        expect(diff.items.some((item) => item.kind === "volume" && item.change === "removed")).toBe(
            false
        );
        // A snapshot has no domains to carry: the type does not even hold them.
        expect(Object.keys(source.services[0]!)).not.toContain("domains");
    });

    it("compares the network mode of the two environments", () => {
        const diff = sync.diffEnvironments(
            snapshot([], { networkMode: "environment" }),
            snapshot([], { networkMode: "shared" })
        );
        expect(diff.items).toEqual([
            expect.objectContaining({ id: "network", from: "shared", to: "environment" })
        ]);
    });
});

describe("permissions", () => {
    const source = snapshot(
        [
            service("api", {
                settings: settings({ build: "new" }),
                variables: [{ key: "K", fingerprint: "1", secret: true }],
                volumes: [{ name: "v", mountPath: "/v" }]
            }),
            service("web")
        ],
        { networkMode: "links" }
    );
    const target = snapshot([service("api"), service("old")]);
    const diff = sync.diffEnvironments(source, target);
    const ids = diff.items.map((item) => item.id);

    it("refuses each item without the capability editing it by hand takes", () => {
        const reach = { source: ["project.read"] as ProjectCapability[], target: ["project.read"] as ProjectCapability[] };
        const result = sync.selectSyncItems(diff, ids, reach);
        expect(result.apply).toEqual([]);
        expect(Object.fromEntries(result.refused.map((one) => [one.id, one.reason]))).toEqual({
            "setting:api:build": "needsConfigure",
            "var:api:K": "needsVariables",
            "volume:api:v": "needsVolumes",
            "add:web": "needsCreate",
            "remove:old": "needsDelete",
            network: "needsSettings"
        });
    });

    it("never copies a value the reader cannot read where it comes from", () => {
        const reach = { source: ["project.read"] as ProjectCapability[], target: EVERYTHING };
        const item = diff.items.find((one) => one.id === "var:api:K")!;
        expect(sync.syncRefusal(item, reach)).toBe("needsSourceVariables");
        const adds = sync.diffEnvironments(
            snapshot([service("new", { variables: [{ key: "K", fingerprint: "1", secret: true }] })]),
            snapshot([])
        ).items[0]!;
        expect(sync.syncRefusal(adds, reach)).toBe("needsSourceVariables");
        expect(sync.syncRefusal(adds, { source: EVERYTHING, target: EVERYTHING })).toBeNull();
    });

    it("applies everything picked when every capability is held", () => {
        const result = sync.selectSyncItems(diff, ids, { source: EVERYTHING, target: EVERYTHING });
        expect(result.refused).toEqual([]);
        expect(result.apply.map((item) => item.id)).toEqual(ids);
    });

    it("skips an id the diff no longer has rather than failing", () => {
        const result = sync.selectSyncItems(diff, ["setting:api:gone", "add:web"], {
            source: EVERYTHING,
            target: EVERYTHING
        });
        expect(result.apply.map((item) => item.id)).toEqual(["add:web"]);
        expect(result.refused).toEqual([]);
    });
});

describe("sync.syncAffectedServices", () => {
    it("redeploys only what was touched, and everything when shared values change", () => {
        const diff = sync.diffEnvironments(
            snapshot([service("api", { settings: settings({ replicas: "2" }) }), service("web")]),
            snapshot([service("api"), service("web"), service("old")])
        );
        expect(sync.syncAffectedServices(diff.items, ["api", "web", "old"])).toEqual(["api"]);
        const shared = sync.diffEnvironments(
            snapshot([service("api")], { sharedVariables: [{ key: "X", fingerprint: "1", secret: false }] }),
            snapshot([service("api"), service("old")])
        );
        expect(sync.syncAffectedServices(shared.items, ["api", "old"])).toEqual(["api"]);
    });
});

describe("sync.environmentSyncSchema", () => {
    it("refuses the same environment on both sides and an empty pick", () => {
        expect(
            sync.environmentSyncSchema.safeParse({
                sourceEnvironmentId: SOURCE_ID,
                targetEnvironmentId: SOURCE_ID,
                items: ["add:web"]
            }).success
        ).toBe(false);
        expect(
            sync.environmentSyncSchema.safeParse({
                sourceEnvironmentId: SOURCE_ID,
                targetEnvironmentId: TARGET_ID,
                items: []
            }).success
        ).toBe(false);
        expect(
            sync.environmentSyncSchema.parse({
                sourceEnvironmentId: SOURCE_ID,
                targetEnvironmentId: TARGET_ID,
                items: ["add:web"]
            }).mode
        ).toBe("deploy");
    });
});
