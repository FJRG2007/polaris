/**
 * Server-run members in a sealed conversation: Polar, added there, opens a
 * sealed question with its own MLS device, reads the sealed conversation
 * before it, and answers sealed - never in the clear, with no draft streamed
 * while it writes; a change it offers is sealed in the answer, and Approve and
 * Cancel seal what follows over it; a webhook's post there is sealed by the
 * webhook's device. Against a person's device over the route. Skipped where
 * the Node binding is not built (CI's MLS job requires it).
 */

import "fake-indexeddb/auto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
    tables: {} as Record<string, Row[]>,
    user: null as { id: string } | null,
    members: new Set<string>(),
    seq: 0n,
    asked: [] as Row[],
    posted: 0,
    sent: 0,
    /** What the model answers next, in order; the usual answer once they run out. */
    answers: [] as { text: string; problem: string | null; pending?: unknown }[],
    updates: [] as Row[],
    held: [] as Row[]
}));

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: Buffer.alloc(32, 9).toString("base64") }) }));
vi.mock("@/lib/session", () => ({ backgroundUser: async () => state.user }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/chat/messages", () => ({
    unfurlLater: () => undefined,
    send: async (actor: { id: string }, input: { channelId: string; body: string; clientKey?: string; parentId?: string | null }, ...rest: unknown[]) => {
        const id = crypto.randomUUID();
        const quoted = rest[1] as { messageId: string } | null;
        (state.tables.chatMessage ??= []).push({
            id,
            channelId: input.channelId,
            authorId: actor.id,
            clientKey: input.clientKey,
            body: input.body,
            kind: "text",
            parentId: input.parentId ?? null,
            replyToId: quoted?.messageId ?? null,
            deletedAt: null,
            createdAt: new Date(Date.now() + state.sent++),
            ...(rest[5] as Row)
        });
        return id;
    }
}));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));
vi.mock("@/lib/chat/vanish", () => ({ expiryForChannel: async () => null }));
vi.mock("@/lib/chat/chat-lock", () => ({ unhideOnMessage: async () => undefined }));
vi.mock("@/lib/chat/custom-emoji", () => ({ confineCustomEmoji: async (body: string) => body }));
vi.mock("@/lib/chat/link-safety", () => ({ checkLinksLater: () => undefined }));
vi.mock("@/lib/avatar-service", () => ({ discardAvatars: async () => undefined }));
vi.mock("@/lib/chat/access", () => ({
    ChatAccessError: class extends Error {},
    channelAccess: async (actor: { id: string }, channelId: string) => (state.members.has(`${actor.id}:${channelId}`) ? { id: channelId } : null),
    conversationAudience: async (actor: { id: string }, channelId: string) =>
        state.members.has(`${actor.id}:${channelId}`) ? [...state.members].filter((m) => m.endsWith(`:${channelId}`)).map((m) => m.slice(0, m.indexOf(":"))) : null
}));
vi.mock("@/lib/cron/lease", () => ({ withLease: async <T,>(_key: string, _ttl: number, work: () => Promise<T>) => work() }));
vi.mock("@/lib/chat/text", () => ({ chatWordsFor: async () => (key: string) => key }));
vi.mock("@/lib/chat/advanced-privacy", () => ({ isShielded: async () => false }));
vi.mock("@/lib/chat/rules", () => ({ rulesForChannel: async () => ({ maxMessageLength: 4000, keepEditHistory: true }) }));
vi.mock("@/lib/chat/history-visibility", () => ({ readableSince: async () => null, sinceClause: () => ({}) }));
vi.mock("@/lib/chat/agent-message", () => ({
    postAgentMessage: async () => {
        state.posted++;
        return crypto.randomUUID();
    },
    updateAgentMessage: async (input: Row & { components?: unknown[] }) => {
        state.updates.push(input);
        const row = state.tables.chatMessage?.find((r) => r.id === input.messageId && r.agent === input.agent);
        if (!row) return false;
        if (input.components) row.components = input.components.length ? input.components : null;
        return true;
    }
}));
vi.mock("@/lib/chat/polar-calls", () => ({
    MENTION_STEPS: 3,
    callComponents: (id: string, asker: string) => [{ type: "button", action: "polar.approve", value: id, for: asker }],
    describeCall: (call: { title: string; input: unknown }) => `Wants to ${call.title}: ${JSON.stringify(call.input)}`,
    holdCall: async (input: Row) => void state.held.push(input),
    mentionToolkit: async () => ({ tools: {} }),
    mentionToolRules: () => []
}));
vi.mock("@/lib/polar/mention-answer", () => ({
    questionOf: (question: string) => question.replace(/@polar/gi, "").trim(),
    answerMentionWithReason: async (input: Row) => {
        state.asked.push(input);
        return { pending: null, ...(state.answers.shift() ?? { text: "You said the build is green.", problem: null }) };
    }
}));
vi.mock("@polaris/db", async () => ({ prisma: (await import("./support/mls-tables")).memoryPrisma(state), Prisma: { DbNull: null } }));

const { handleMls } = await import("@/lib/chat/e2ee/mls-handler");
const { MlsDevice, MlsRequestError } = await import("@/lib/chat/e2ee/mls-client");
const { IndexedDbMlsStore } = await import("@polaris/core-rs/mls-store");
const { forgetServiceDevice, withServiceDevice } = await import("@/lib/chat/e2ee/service-device");
const { answerSealedPolar, approveSealedPolar, cancelSealedPolar } = await import("@/lib/chat/e2ee/sealed-polar");
const { postThroughWebhook } = await import("@/lib/chat/webhooks");
const { pressComponent } = await import("@/lib/chat/component-actions");
const { encodeSealedContent, decodeSealedContent } = await import("@/lib/chat/e2ee/sealed-chat");
const { POLAR_SERVICE_ID, WEBHOOK_SERVICE_ID, serviceDevice } = await import("@/lib/chat/service-members");
type MlsMemberClass = import("@/lib/chat/e2ee/mls-client").MlsMemberClass;
type MlsTransport = import("@/lib/chat/e2ee/mls-client").MlsTransport;

const ALICE = "11111111-1111-4111-8111-111111111111";
const CHANNEL = "44444444-4444-4444-8444-444444444444";
const HOOK = "77777777-7777-4777-8777-777777777777";
const POLAR_ADDRESS = `${POLAR_SERVICE_ID}/${serviceDevice(CHANNEL)}`;

const nativeDir = join(dirname(fileURLToPath(import.meta.url)), "../../../../../packages/core-rs/native");
const nativeFile = existsSync(nativeDir) ? readdirSync(nativeDir).find((f) => f.startsWith(`polaris-core.${process.platform}-${process.arch}`)) : undefined;
if (process.env.POLARIS_REQUIRE_CORE_RS_NATIVE && !nativeFile) throw new Error(`no Node binding of @polaris/core-rs for ${process.platform}-${process.arch} in ${nativeDir}`);

const QUESTION = { channelId: CHANNEL, authorId: ALICE, parentId: null, replyToId: null };

beforeEach(() => {
    process.env.POLARIS_INTERNAL_CHAT_E2EE = "1";
    state.tables = { chatChannel: [{ id: CHANNEL, lastMessageAt: null }], user: [{ id: ALICE, name: "Alice", username: "alice" }] };
    state.seq = 0n;
    state.asked = [];
    state.posted = 0;
    state.answers = [];
    state.updates = [];
    state.held = [];
    state.members = new Set([`${ALICE}:${CHANNEL}`]);
});

describe("Polar in a sealed conversation, before anything is opened", () => {
    it("does nothing while sealed chat is off", async () => {
        delete process.env.POLARIS_INTERNAL_CHAT_E2EE;
        expect(await answerSealedPolar({ ...QUESTION, messageId: crypto.randomUUID() })).toBeNull();
        expect(state.tables.mlsStoreEntry ?? []).toEqual([]);
    });

    it("does not open its device where nobody added it", async () => {
        expect(await answerSealedPolar({ ...QUESTION, messageId: crypto.randomUUID() })).toBeNull();
        expect(state.tables.mlsStoreEntry ?? []).toEqual([]);
        expect(state.asked).toEqual([]);
    });
});

describe.skipIf(!nativeFile)("Polar and a webhook against a person's device", () => {
    const { MlsMember } = (nativeFile ? createRequire(import.meta.url)(join(nativeDir, nativeFile)) : {}) as { MlsMember: MlsMemberClass };
    const asAlice: MlsTransport = async (body) => {
        state.user = { id: ALICE };
        const response = await handleMls(new Request("http://x/api/e2ee/mls", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
        const answer = (await response.json()) as Record<string, unknown>;
        if (!response.ok) throw new MlsRequestError(response.status, String(answer.error));
        return answer;
    };
    const notes = new Map<string, string>();
    const alice = async () => {
        const device = await MlsDevice.open({
            userId: ALICE,
            device: `alice-${crypto.randomUUID().slice(0, 8)}`,
            MlsMember,
            store: await IndexedDbMlsStore.open(crypto.randomUUID()),
            transport: asAlice,
            notes: { getItem: (k) => notes.get(k) ?? null, setItem: (k, v) => void notes.set(k, v) }
        });
        await device.register();
        await device.ensureGroup(CHANNEL);
        return device;
    };
    const say = (device: InstanceType<typeof MlsDevice>, body: string) => device.sendSealed(CHANNEL, encodeSealedContent({ body }));
    const opened = async (device: InstanceType<typeof MlsDevice>, id: string) => {
        const [row] = await device.readSealed(CHANNEL, [id]);
        return row?.opened ? decodeSealedContent(row.opened)?.body : undefined;
    };
    const addPolar = async () => {
        state.tables.chatServiceMember = [{ channelId: CHANNEL, service: "polar", addedById: ALICE }];
        state.members.add(`${POLAR_SERVICE_ID}:${CHANNEL}`);
        // What adding it does in a sealed conversation (`polar-member.ts`): it joins the group now.
        await withServiceDevice("polar", CHANNEL, async (device) => void (await device.ensureGroup(CHANNEL)), { MlsMember });
    };

    it("opens a sealed question, reads the sealed conversation, and answers sealed", async () => {
        const person = await alice();
        await addPolar();
        await say(person, "the build is green");
        // Answered in the background of the send; the next steps wait for it.
        const asked = await say(person, "@polar what did I say?");
        await vi.waitFor(() => expect(state.tables.chatMessage?.some((r) => r.agent === "polar")).toBe(true), { timeout: 15_000 });

        expect(state.asked).toHaveLength(1);
        const input = state.asked[0] as { prompt: string; toolkit: unknown; draft?: unknown };
        expect(input.prompt).toContain("Alice: the build is green");
        expect(input.prompt).toContain("what did I say?");
        // The asker's tools, as in a plain conversation.
        expect(input.toolkit).toEqual({ tools: {} });
        expect(input.draft).toBeUndefined();
        expect(state.posted).toBe(0);

        const answer = state.tables.chatMessage?.find((r) => r.agent === "polar") as Row;
        expect(answer).toMatchObject({ authorId: null, body: "", replyToId: asked, e2eeDevice: serviceDevice(CHANNEL) });
        expect(answer.e2eeCiphertext).toBeInstanceOf(Uint8Array);
        expect(await opened(person, answer.id as string)).toBe("You said the build is green.");
    }, 30_000);

    it("puts \"Try again\" under a sealed answer that is not one, and seals the new answer over it", async () => {
        const person = await alice();
        await addPolar();
        state.answers.push({ text: "Polar could not answer.", problem: "failed" });
        const asked = await say(person, "@polar what is the plan?");
        await vi.waitFor(() => expect(state.updates).toHaveLength(1), { timeout: 15_000 });
        const answer = state.tables.chatMessage?.find((r) => r.agent === "polar") as Row;
        // The button goes on after the sealed post, which is not an edit of it.
        expect(state.updates[0]).toMatchObject({ messageId: answer.id, edited: false, components: [{ type: "button", action: "polar.retry", for: ALICE }] });
        expect(answer.components).toHaveLength(1);
        expect(answer.body).toBe("");
        expect(await opened(person, answer.id as string)).toBe("Polar could not answer.");

        await pressComponent({ id: ALICE, isAdmin: false }, { messageId: answer.id as string, index: 0 });
        expect(state.asked).toHaveLength(2);
        expect((state.asked[1] as { prompt: string }).prompt).toContain("what is the plan?");
        // The same row, its next revision, sealed by Polar's device; nothing posted beside it, nothing in the clear.
        expect(state.tables.chatMessage?.filter((r) => r.agent === "polar")).toHaveLength(1);
        expect(answer).toMatchObject({ body: "", replyToId: asked, e2eeRevision: 1, e2eeDevice: serviceDevice(CHANNEL), components: null });
        expect(state.posted).toBe(0);
        const [read] = await person.readSealed(CHANNEL, [answer.id as string]);
        expect(read?.revision).toBe(1);
        expect(await opened(person, answer.id as string)).toBe("You said the build is green.");
        // The failed version is kept, sealed as it was.
        expect(state.tables.chatMessageEdit?.find((r) => r.messageId === answer.id)).toMatchObject({ body: "", e2eeRevision: null });
    }, 30_000);

    it("moves the provider link of a sealed answer to its button", async () => {
        const person = await alice();
        await addPolar();
        state.answers.push({ text: "Polar has no provider. [Set one up](/polar/settings/providers)", problem: "noProvider" });
        await say(person, "@polar hello");
        await vi.waitFor(() => expect(state.updates).toHaveLength(1), { timeout: 15_000 });
        const answer = state.tables.chatMessage?.find((r) => r.agent === "polar") as Row;
        expect(state.updates[0]).toMatchObject({ components: [{ type: "link", href: "/polar/settings/providers" }], edited: false });
        expect(await opened(person, answer.id as string)).toBe("Polar has no provider.");
    }, 30_000);

    const offer = async () => {
        const person = await alice();
        await addPolar();
        state.answers.push({ text: "I will make it.", problem: null, pending: { tool: "tasks_create", title: "Create task", input: { name: "Fix staging" } } });
        const asked = await say(person, "@polar make a task called Fix staging");
        await vi.waitFor(() => expect(state.held).toHaveLength(1), { timeout: 15_000 });
        const answer = state.tables.chatMessage?.find((r) => r.agent === "polar") as Row;
        return { person, asked, answer };
    };

    it("offers a change sealed, its buttons after, and keeps it sealed for the approval", async () => {
        const { person, answer } = await offer();
        expect(answer.body).toBe("");
        const text = await opened(person, answer.id as string);
        expect(text).toContain("I will make it.");
        expect(text).toContain("Fix staging");
        const callId = (state.held[0] as { id: string }).id;
        expect(state.held[0]).toMatchObject({ messageId: answer.id, ownerId: ALICE, sealed: true });
        expect(state.updates[0]).toMatchObject({ messageId: answer.id, edited: false, components: [{ action: "polar.approve", value: callId, for: ALICE }] });
        expect(state.posted).toBe(0);
    }, 30_000);

    it("answers an approval sealed over the offer, with what was done", async () => {
        const { person, asked, answer } = await offer();
        state.answers.push({ text: "Made the task Fix staging.", problem: null });
        const done = [{ tool: "tasks_create", title: "Create task", ok: true, text: "made it" }];
        const question = { ...QUESTION, messageId: asked };
        expect(await approveSealedPolar(question, answer.id as string, async () => done)).toBe(true);
        expect((state.asked[1] as { prompt: string }).prompt).toContain("made it");
        expect(state.tables.chatMessage?.filter((r) => r.agent === "polar")).toHaveLength(1);
        expect(answer).toMatchObject({ body: "", e2eeRevision: 1, components: null });
        expect(await opened(person, answer.id as string)).toBe("Made the task Fix staging.");
    }, 30_000);

    it("runs nothing on an approval once Polar is taken out", async () => {
        const { asked, answer } = await offer();
        state.tables.chatServiceMember = [];
        let ran = false;
        const result = await approveSealedPolar({ ...QUESTION, messageId: asked }, answer.id as string, async () => {
            ran = true;
            return [];
        });
        expect(result).toBe(false);
        expect(ran).toBe(false);
    }, 30_000);

    it("seals a cancellation over the offer and takes its buttons off", async () => {
        const { person, answer } = await offer();
        await cancelSealedPolar(CHANNEL, answer.id as string, "Cancelled.");
        expect(answer).toMatchObject({ body: "", e2eeRevision: 1, components: null });
        expect(await opened(person, answer.id as string)).toBe("Cancelled.");
    }, 30_000);

    it("edits nothing of a person's with Polar's device", async () => {
        const person = await alice();
        await addPolar();
        const mine = await say(person, "mine to edit");
        const refused = withServiceDevice("polar", CHANNEL, (device) => device.editSealed(CHANNEL, mine, encodeSealedContent({ body: "Polar's words" })));
        await expect(refused).rejects.toMatchObject({ reason: "notSealed" });
        expect(state.tables.chatMessage?.find((r) => r.id === mine)?.e2eeRevision ?? null).toBeNull();
    }, 30_000);

    it("leaves a sealed message that does not ask it alone", async () => {
        const person = await alice();
        await addPolar();
        const id = await say(person, "nothing for the bot here");
        expect(await answerSealedPolar({ ...QUESTION, messageId: id })).toBeNull();
        expect(state.asked).toEqual([]);
    }, 30_000);

    it("cannot open what was said before it was added", async () => {
        const person = await alice();
        const before = await say(person, "@polar this was before you");
        await addPolar();
        expect(await answerSealedPolar({ ...QUESTION, messageId: before })).toBeNull();
        expect(state.tables.mlsStoreEntry?.some((r) => r.device === POLAR_ADDRESS)).toBe(true);
    }, 30_000);

    it("keeps nothing of Polar's device once it is taken out", async () => {
        await alice();
        await addPolar();
        expect(state.tables.mlsStoreEntry?.some((r) => r.device === POLAR_ADDRESS)).toBe(true);
        await forgetServiceDevice("polar", CHANNEL);
        expect(state.tables.mlsStoreEntry?.some((r) => r.device === POLAR_ADDRESS)).toBe(false);
    }, 30_000);

    it("posts a webhook's message sealed in a sealed conversation, under the name it was given", async () => {
        const person = await alice();
        state.tables.chatWebhook = [{ id: HOOK, channelId: CHANNEL, name: "Deploys" }];
        state.members.add(`${WEBHOOK_SERVICE_ID}:${CHANNEL}`);
        const id = await postThroughWebhook({ id: HOOK, channelId: CHANNEL, name: "Deploys" }, { content: "build 42 is out", username: "CI" });
        const row = state.tables.chatMessage?.find((r) => r.id === id);
        expect(row).toMatchObject({ authorId: null, body: "", webhookId: HOOK, authorLabel: "CI" });
        // The webhook joined by its own commit; the person's device reads that epoch's history key from the log.
        await person.sync(CHANNEL);
        expect(await opened(person, id)).toBe("build 42 is out");
    }, 30_000);
});
