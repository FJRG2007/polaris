/**
 * Which rules a conversation is under, and reading them back.
 *
 * The rules themselves are `@polaris/core` - a shape, its defaults, and the pure
 * checks over it. This is the part that needs a database: one row per scope in
 * the settings table, and the lookup that turns a channel into the scope it
 * belongs to.
 *
 * Every write path resolves the scope from the channel rather than being told
 * which one applies. A caller that could name its own scope could name the
 * loosest one.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { getSetting, setSetting } from "@/lib/setting-store";

/** One key per scope, so an admin editing spaces cannot disturb direct
 *  messages. */
function keyFor(scope: core.ChatRuleScope): string {
    return `chat.rules.${scope}`;
}

/** The rules for one scope, defaults included. */
export async function chatRules(scope: core.ChatRuleScope): Promise<core.ChatRules> {
    return core.parseChatRules(await getSetting(keyFor(scope)));
}

/** All three, for the admin screen. */
export async function allChatRules(): Promise<Record<core.ChatRuleScope, core.ChatRules>> {
    const entries = await Promise.all(
        core.CHAT_RULE_SCOPES.map(async (scope) => [scope, await chatRules(scope)] as const)
    );
    return Object.fromEntries(entries) as Record<core.ChatRuleScope, core.ChatRules>;
}

export async function setChatRules(
    scope: core.ChatRuleScope,
    rules: core.ChatRules
): Promise<void> {
    await setSetting(keyFor(scope), JSON.stringify(rules));
}

/**
 * The rules a given channel is under.
 *
 * Two reads rather than one join: the channel row is almost always already warm
 * from the access check that ran a moment earlier, and the settings row is three
 * keys the instance shares.
 */
export async function rulesForChannel(channelId: string): Promise<core.ChatRules> {
    const channel = await prisma.chatChannel.findUnique({
        where: { id: channelId },
        select: { spaceId: true, kind: true }
    });
    // A channel that is not there is refused a moment later by the access layer;
    // handing back the defaults keeps that the refusal anybody sees.
    if (!channel) return core.DEFAULT_CHAT_RULES;
    return chatRules(core.chatRuleScopeOf(channel));
}
