import { describe, expect, it, vi } from "vitest";
import { DiscordAdapter } from "../../src/adapters/discord.js";
import type { AdapterContext } from "@polaris/messaging";

/**
 * Exercises the DM-by-username fix (the "Value user:tpeoficial is not snowflake"
 * crash). The old code passed a raw handle straight to client.users.fetch, which
 * rejects anything that is not a snowflake. The adapter now routes DM ids through
 * resolveUserId first, so users.fetch only ever sees a validated snowflake.
 *
 * discord.js is never logged in here: we build the adapter, then swap its private
 * client for a fake that records what the send path actually asks Discord for.
 */

const SNOWFLAKE = "123456789012345678";

function ctx(): AdapterContext {
    return { channelId: "chan-1", onInbound: vi.fn(), log: vi.fn() };
}

/** A fake discord.js client that records users.fetch / channel.send calls and can
 *  answer a guild member search with the given members. */
function fakeClient(options: {
    members?: { id: string; username: string; globalName?: string; displayName?: string }[];
    membersFetchThrows?: boolean;
}) {
    const usersFetched: string[] = [];
    const sent: { to: string; payload: unknown }[] = [];
    const members = options.members ?? [];

    const memberEntries = members.map((m) => ({
        id: m.id,
        displayName: m.displayName ?? m.username,
        user: { username: m.username, globalName: m.globalName }
    }));

    const guild = {
        members: {
            fetch: async (_query: { query: string; limit: number }) => {
                if (options.membersFetchThrows) throw new Error("Missing GuildMembers intent");
                // discord.js returns a Collection; an array exposes the .find used by the adapter.
                return memberEntries;
            }
        }
    };

    const client = {
        guilds: { cache: new Map([["guild-1", guild]]) },
        users: {
            fetch: async (id: string) => {
                usersFetched.push(id);
                return {
                    createDM: async () => ({
                        isTextBased: () => true,
                        send: async (payload: unknown) => {
                            sent.push({ to: id, payload });
                            return { id: "sent-msg-1" };
                        }
                    })
                };
            }
        }
    };

    return { client, usersFetched, sent };
}

function build(fake: ReturnType<typeof fakeClient>) {
    const adapter = new DiscordAdapter("fake-token", "chan-1", ctx());
    // Replace the real (unconnected) client with the fake before any send.
    (adapter as unknown as { client: unknown }).client = fake.client;
    return adapter;
}

describe("DiscordAdapter DM recipient resolution", () => {
    it("passes a numeric user snowflake straight through to a DM", async () => {
        const fake = fakeClient({});
        const adapter = build(fake);

        const result = await adapter.send({ peerId: `user:${SNOWFLAKE}`, text: "hi" });

        expect(fake.usersFetched).toEqual([SNOWFLAKE]);
        expect(fake.sent).toEqual([{ to: SNOWFLAKE, payload: { content: "hi" } }]);
        expect(result.externalId).toBe("sent-msg-1");
    });

    it("resolves a username to a snowflake before DMing (no snowflake crash)", async () => {
        const fake = fakeClient({ members: [{ id: SNOWFLAKE, username: "tpeoficial" }] });
        const adapter = build(fake);

        await adapter.send({ peerId: "user:tpeoficial", text: "hello there" });

        // The username never reaches users.fetch - only the resolved snowflake does.
        expect(fake.usersFetched).toEqual([SNOWFLAKE]);
        expect(fake.usersFetched).not.toContain("tpeoficial");
        expect(fake.sent[0]).toEqual({ to: SNOWFLAKE, payload: { content: "hello there" } });
    });

    it("strips a leading @ and matches case-insensitively", async () => {
        const fake = fakeClient({ members: [{ id: SNOWFLAKE, username: "tpeoficial" }] });
        const adapter = build(fake);

        await adapter.send({ peerId: "user:@TPEOficial", text: "hey" });

        expect(fake.usersFetched).toEqual([SNOWFLAKE]);
    });

    it("matches on globalName / displayName as well as username", async () => {
        const fake = fakeClient({
            members: [{ id: SNOWFLAKE, username: "someone", globalName: "Juan", displayName: "JR" }]
        });
        const adapter = build(fake);

        await adapter.send({ peerId: "user:juan", text: "hi" });

        expect(fake.usersFetched).toEqual([SNOWFLAKE]);
    });

    it("gives a clear, actionable error when the username cannot be found", async () => {
        const fake = fakeClient({ members: [{ id: SNOWFLAKE, username: "someone-else" }] });
        const adapter = build(fake);

        await expect(adapter.send({ peerId: "user:tpeoficial", text: "hi" })).rejects.toThrow(
            /Could not find a Discord user "tpeoficial"[\s\S]*Server Members intent[\s\S]*numeric User ID/
        );
        // A failed lookup must not attempt a DM against a non-snowflake.
        expect(fake.usersFetched).toEqual([]);
    });

    it("surfaces the same guidance when the Server Members intent is off", async () => {
        const fake = fakeClient({ membersFetchThrows: true });
        const adapter = build(fake);

        await expect(adapter.send({ peerId: "user:tpeoficial", text: "hi" })).rejects.toThrow(
            /Server Members intent/
        );
        expect(fake.usersFetched).toEqual([]);
    });
});
