import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    notified: [] as Array<Record<string, unknown>>,
    inapp: "sent",
    members: [] as string[],
    teamMembers: [] as string[],
    orgOwner: "owner-org",
    adminOf: [] as string[],
    deliveries: [] as Array<Record<string, unknown>>,
    updates: [] as Array<Record<string, unknown>>,
    limitOk: true,
    topic: null as Record<string, unknown> | null,
    canPost: true
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        alertTopic: {
            findUnique: async () => state.topic,
            update: async () => ({})
        },
        alertDelivery: {
            create: async ({ data }: { data: Record<string, unknown> }) => {
                state.deliveries.push(data);
                return { id: "delivery-1" };
            },
            update: async ({ data }: { data: Record<string, unknown> }) => {
                state.updates.push(data);
                return {};
            },
            deleteMany: async () => ({ count: 0 })
        },
        organization: {
            findUnique: async () => ({ ownerId: state.orgOwner }),
            findMany: async () => []
        },
        organizationMember: {
            findMany: async ({ where }: { where: { userId?: { in?: string[] } | string; role?: string } }) => {
                if (where.role === "admin") return state.adminOf.map((orgId) => ({ orgId }));
                const wanted = typeof where.userId === "object" ? (where.userId.in ?? []) : [];
                return state.members.filter((id) => wanted.includes(id)).map((userId) => ({ userId }));
            }
        },
        teamMember: {
            findMany: async () => state.teamMembers.map((userId) => ({ userId }))
        }
    }
}));

vi.mock("@/lib/notifications/dispatch", () => ({
    notify: async (input: Record<string, unknown>) => {
        state.notified.push(input);
        return { inapp: state.inapp };
    }
}));

vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async () => (state.limitOk ? { ok: true } : { ok: false, retryAfterMs: 12_500 })
}));

vi.mock("@/lib/request-context", () => ({ clientIp: async () => "203.0.113.9" }));

const topics = await import("@/lib/alerts/topics");
const { parseNtfyText } = await import("@/lib/alerts/parse");

const TOPIC_ID = "0190b6a2-0000-7000-8000-000000000001";
const SECRET = "the-secret";

function topic(extra: Record<string, unknown> = {}) {
    return {
        id: TOPIC_ID,
        ownerId: "owner",
        orgId: null,
        name: "Company dashboard",
        tokenHash: topics.hashSecret(SECRET),
        tokenTail: "cret",
        defaultPriority: 3,
        pushFrom: 3,
        recipientUserIds: [],
        recipientTeamIds: [],
        lastUsedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...extra
    } as Parameters<typeof topics.deliverAlert>[0];
}

function alert(headers: Record<string, string> = {}, body = "Disk full") {
    const parsed = parseNtfyText(new Headers(headers), new URLSearchParams(), body);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.alert;
}

beforeEach(() => {
    state.notified = [];
    state.inapp = "sent";
    state.members = [];
    state.teamMembers = [];
    state.adminOf = [];
    state.deliveries = [];
    state.updates = [];
    state.limitOk = true;
    state.topic = null;
});

describe("the secret", () => {
    it("matches only the one whose hash is stored", async () => {
        expect(topics.secretMatches(SECRET, topics.hashSecret(SECRET))).toBe(true);
        expect(topics.secretMatches("other", topics.hashSecret(SECRET))).toBe(false);
        state.topic = topic();
        expect(await topics.topicFor(TOPIC_ID, SECRET)).not.toBeNull();
        expect(await topics.topicFor(TOPIC_ID, "wrong")).toBeNull();
        expect(await topics.topicFor("not-a-uuid", SECRET)).toBeNull();
        expect(await topics.topicFor(TOPIC_ID, "")).toBeNull();
    });

    it("is new each time and never stored in the clear", () => {
        const a = topics.newSecret();
        expect(a).not.toBe(topics.newSecret());
        expect(a.length).toBeGreaterThanOrEqual(40);
        expect(topics.hashSecret(a)).not.toContain(a);
    });
});

describe("recipients", () => {
    it("is the owner for a personal topic", async () => {
        expect(await topics.recipientsOf(topic())).toEqual(["owner"]);
    });

    it("is the named people and teams of an organization's topic, while still members", async () => {
        state.members = ["owner", "ana", "team-bo"];
        state.teamMembers = ["team-bo", "team-gone"];
        const found = await topics.recipientsOf(
            topic({ orgId: "org-1", recipientUserIds: ["ana", "left-org"], recipientTeamIds: ["team-1"] })
        );
        expect(found.sort()).toEqual(["ana", "owner", "team-bo"]);
    });
});

describe("delivery", () => {
    it("raises the severity's event on every recipient's bell, through notify", async () => {
        await topics.deliverAlert(topic(), alert({ Priority: "urgent", Title: "Down" }), "ntfy");
        expect(state.notified).toHaveLength(1);
        expect(state.notified[0]).toMatchObject({
            userId: "owner",
            event: "alerts.urgent",
            title: "Down",
            body: "Disk full",
            level: "danger",
            href: "/account/alerts/d/delivery-1",
            shelf: { orgId: null },
            push: { requireInteraction: true }
        });
        expect(state.deliveries[0]).toMatchObject({ priority: 5, source: "ntfy", recipients: 1 });
    });

    it("uses the topic's default severity and name when the sender gives none", async () => {
        await topics.deliverAlert(topic({ defaultPriority: 4 }), alert(), "ntfy");
        expect(state.notified[0]).toMatchObject({ event: "alerts.high", title: "Company dashboard", level: "warning" });
    });

    it("pushes only from the topic's push severity, and never a minimum alert", async () => {
        await topics.deliverAlert(topic({ pushFrom: 4 }), alert({ Priority: "3" }), "ntfy");
        await topics.deliverAlert(topic({ pushFrom: 4 }), alert({ Priority: "4" }), "ntfy");
        await topics.deliverAlert(topic({ pushFrom: 2 }), alert({ Priority: "min" }), "ntfy");
        expect(state.notified.map((input) => Boolean(input.push))).toEqual([false, true, false]);
        expect(state.notified[2]!.event).toBe("alerts.min");
    });

    it("folds a repeat with the same dedup key into one alert", async () => {
        await topics.deliverAlert(topic(), alert({ "X-Dedup-Key": "disk" }), "ntfy");
        expect(state.notified[0]!.dedupKey).toBe(`alert:${TOPIC_ID}:disk`);
        state.inapp = "collapsed";
        await topics.deliverAlert(topic(), alert({ "X-Dedup-Key": "disk" }), "ntfy");
        expect(state.updates).toContainEqual({ status: "folded" });
    });

    it("leaves an alert without a key to notify's own repeat check", async () => {
        await topics.deliverAlert(topic(), alert(), "ntfy");
        expect(state.notified[0]!.dedupKey).toBeUndefined();
    });
});

describe("who manages a topic", () => {
    it("is its owner for a personal one, and an organization's admins for theirs", async () => {
        expect(await topics.canManage("owner", { ownerId: "owner", orgId: null })).toBe(true);
        expect(await topics.canManage("ana", { ownerId: "owner", orgId: null })).toBe(false);
        state.adminOf = ["org-1"];
        expect(await topics.canManage("ana", { ownerId: "owner", orgId: "org-1" })).toBe(true);
        state.adminOf = [];
        expect(await topics.canManage("owner", { ownerId: "owner", orgId: "org-1" })).toBe(false);
    });

    it("refuses to create an organization's topic for somebody who does not run it", async () => {
        await expect(
            topics.createTopic("ana", {
                name: "Ops",
                orgId: "0190b6a2-0000-7000-8000-0000000000aa",
                defaultPriority: 3,
                pushFrom: 3,
                recipientUserIds: [],
                recipientTeamIds: []
            })
        ).rejects.toMatchObject({ code: "forbidden" });
    });
});

describe("the publish endpoints", () => {
    const route = () => import("@/app/api/alerts/[id]/[token]/route");
    const root = () => import("@/app/api/alerts/[id]/route");
    const params = (token?: string) => ({ params: Promise.resolve({ id: TOPIC_ID, token: token ?? "" }) });

    it("delivers an ntfy text publish to the secret address", async () => {
        state.topic = topic();
        const { POST } = await route();
        const response = await POST(
            new Request(`https://polaris.example.test/api/alerts/${TOPIC_ID}/${SECRET}`, {
                method: "POST",
                headers: { Title: "Hi", Priority: "high" },
                body: "Backup finished"
            }),
            params(SECRET)
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ event: "message", priority: 4, message: "Backup finished" });
        expect(state.notified[0]).toMatchObject({ event: "alerts.high", title: "Hi" });
    });

    it("answers the same 404 for a wrong secret, and says nothing else", async () => {
        state.topic = topic();
        const { POST } = await route();
        const response = await POST(
            new Request(`https://polaris.example.test/api/alerts/${TOPIC_ID}/nope`, { method: "POST", body: "x" }),
            params("nope")
        );
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "Unknown topic", http: 404 });
        expect(state.notified).toHaveLength(0);
    });

    it("tells a sender over the limit when to come back", async () => {
        state.topic = topic();
        state.limitOk = false;
        const { POST } = await route();
        const response = await POST(
            new Request(`https://polaris.example.test/api/alerts/${TOPIC_ID}/${SECRET}`, { method: "POST", body: "x" }),
            params(SECRET)
        );
        expect(response.status).toBe(429);
        expect(response.headers.get("Retry-After")).toBe("13");
        expect(state.notified).toHaveLength(0);
    });

    it("takes Gotify's create-message with the token in the query or header", async () => {
        state.topic = topic();
        const { POST } = await route();
        const byQuery = await POST(
            new Request(`https://polaris.example.test/api/alerts/${TOPIC_ID}/message?token=${SECRET}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title: "Nightly", message: "done", priority: 10 })
            }),
            params("message")
        );
        expect(byQuery.status).toBe(200);
        expect(await byQuery.json()).toMatchObject({ title: "Nightly", priority: 5 });
        const byForm = await POST(
            new Request(`https://polaris.example.test/api/alerts/${TOPIC_ID}/message`, {
                method: "POST",
                headers: { "X-Gotify-Key": SECRET, "Content-Type": "application/x-www-form-urlencoded" },
                body: "title=a&message=b&priority=2"
            }),
            params("message")
        );
        expect(byForm.status).toBe(200);
        const noToken = await POST(
            new Request(`https://polaris.example.test/api/alerts/${TOPIC_ID}/message`, {
                method: "POST",
                body: JSON.stringify({ message: "b" })
            }),
            params("message")
        );
        expect(noToken.status).toBe(404);
    });

    it("takes ntfy's JSON with the secret as its topic, and Polaris JSON with a bearer token", async () => {
        state.topic = topic();
        const { POST } = await root();
        const ntfy = await POST(
            new Request(`https://polaris.example.test/api/alerts/${TOPIC_ID}`, {
                method: "POST",
                body: JSON.stringify({ topic: SECRET, message: "Kuma says down", priority: 5 })
            }),
            params()
        );
        expect(ntfy.status).toBe(200);
        const native = await POST(
            new Request(`https://polaris.example.test/api/alerts/${TOPIC_ID}`, {
                method: "POST",
                headers: { Authorization: `Bearer ${SECRET}` },
                body: JSON.stringify({ message: "x", severity: "low" })
            }),
            params()
        );
        expect(native.status).toBe(200);
        const strict = await POST(
            new Request(`https://polaris.example.test/api/alerts/${TOPIC_ID}`, {
                method: "POST",
                headers: { Authorization: `Bearer ${SECRET}` },
                body: JSON.stringify({ message: "x", extra: true })
            }),
            params()
        );
        expect(strict.status).toBe(400);
        expect(state.notified.map((input) => input.event)).toEqual(["alerts.urgent", "alerts.low"]);
    });

    it("refuses a body larger than a publish may be", async () => {
        state.topic = topic();
        const { POST } = await route();
        const response = await POST(
            new Request(`https://polaris.example.test/api/alerts/${TOPIC_ID}/${SECRET}`, {
                method: "POST",
                body: "a".repeat(64 * 1024)
            }),
            params(SECRET)
        );
        expect(response.status).toBe(413);
    });
});
