/** A small team's chat: one space, a few channels, a conversation in progress. */

import { TEAM, VIEWER, ago, id } from "./people";
import type { SceneContext } from "../runtime/scene";
import type { ChatMessageView } from "@/lib/chat/messages";
import type { ChatChannelView, ChatSpaceView, ChatCategoryView } from "@/lib/chat/chat-service";

export const SPACE_ID = id("space", 1);
export const CHANNEL_ID = id("channel", 1);

function channel(
    ctx: SceneContext,
    n: number,
    name: string,
    topic: string,
    extra: Partial<ChatChannelView> = {}
): ChatChannelView {
    return {
        id: id("channel", n),
        spaceId: SPACE_ID,
        categoryId: id("category", 1),
        kind: "text",
        name,
        topic,
        private: false,
        archived: false,
        lastMessageAt: ago(ctx.now, n * 7),
        unread: 0,
        muted: false,
        notifyLevel: "inherit",
        pinned: false,
        mutedUntil: null,
        mayAdminister: true,
        mayChangePrivacy: true,
        mayModerate: true,
        mayPicture: true,
        mayPin: true,
        ownerId: VIEWER.id,
        membersMayEdit: true,
        membersMayInvite: true,
        mayInvite: true,
        membersMayMention: true,
        mayMentionRoom: true,
        slowmode: 0,
        userLimit: 0,
        contentMode: "default",
        ageConfirmed: false,
        others: [],
        blocked: false,
        gameLinks: [],
        ...extra
    };
}

export function chatChannels(ctx: SceneContext): ChatChannelView[] {
    const say = ctx.say;
    return [
        channel(ctx, 1, say("launch", "lanzamiento"), say("Everything for the March release", "Todo para la versión de marzo")),
        channel(ctx, 2, say("general", "general"), "", { unread: 3 }),
        channel(ctx, 3, say("design", "diseño"), ""),
        channel(ctx, 4, say("ops", "operaciones"), "", { unread: 1 }),
        channel(ctx, 5, say("standup", "daily"), "", { kind: "voice" }),
        channel(ctx, 6, TEAM.ana.name, "", {
            spaceId: null,
            categoryId: null,
            kind: "dm",
            others: [{ id: TEAM.ana.id, name: TEAM.ana.name }]
        }),
        channel(ctx, 7, TEAM.kenji.name, "", {
            spaceId: null,
            categoryId: null,
            kind: "dm",
            unread: 2,
            others: [{ id: TEAM.kenji.id, name: TEAM.kenji.name }]
        })
    ];
}

export function chatSpaces(ctx: SceneContext): ChatSpaceView[] {
    return [
        {
            id: SPACE_ID,
            name: ctx.say("Northwind team", "Equipo Northwind"),
            description: "",
            color: "#6366f1",
            visibility: "private",
            orgId: null,
            orgName: null,
            archived: false,
            access: "owner",
            notifyLevel: "all"
        }
    ];
}

export function chatCategories(ctx: SceneContext): ChatCategoryView[] {
    return [{ id: id("category", 1), spaceId: SPACE_ID, name: ctx.say("Channels", "Canales") }];
}

export function message(
    ctx: SceneContext,
    n: number,
    author: { id: string; name: string },
    minutesAgo: number,
    body: string,
    extra: Partial<ChatMessageView> = {}
): ChatMessageView {
    return {
        id: id("message", n),
        channelId: CHANNEL_ID,
        authorId: author.id,
        authorName: author.name,
        kind: "text",
        body,
        parentId: null,
        replyCount: 0,
        lastReplyAt: null,
        edited: false,
        deleted: false,
        reactions: [],
        attachments: [],
        poll: null,
        quote: null,
        starred: false,
        blocked: false,
        mentionsYou: false,
        references: [],
        forwardable: true,
        link: null,
        preview: null,
        previewPending: false,
        receipt: null,
        createdAt: ago(ctx.now, minutesAgo),
        ...extra
    };
}

/** The conversation on screen, oldest first. */
export function launchConversation(ctx: SceneContext): ChatMessageView[] {
    const say = ctx.say;
    return [
        message(ctx, 1, TEAM.ana, 52, say("Morning! Release candidate is building now.", "¡Buenos días! La versión candidata ya se está compilando.")),
        message(ctx, 2, TEAM.sam, 47, say("Staging is green. I ran the smoke tests twice.", "Staging en verde. He pasado las pruebas de humo dos veces."), {
            reactions: [{ emoji: "\u{1F44D}", count: 3, mine: true }]
        }),
        message(ctx, 3, TEAM.lena, 31, say("The new onboarding screens are in the design doc, feedback welcome.", "Las nuevas pantallas de bienvenida están en el documento de diseño, se aceptan comentarios.")),
        message(ctx, 4, VIEWER, 22, say("Looks great. Let's ship it on Thursday after the standup.", "Queda genial. Lo publicamos el jueves después de la daily.")),
        message(ctx, 5, TEAM.kenji, 9, say("I'll update the changelog and tag the release.", "Actualizo el changelog y etiqueto la versión."), {
            reactions: [{ emoji: "\u{1F680}", count: 2, mine: false }]
        })
    ];
}

/** What arrives while the animation plays. */
export function arriving(ctx: SceneContext): ChatMessageView[] {
    const say = ctx.say;
    return [
        message(ctx, 6, TEAM.ana, 1, say("Deploy finished, it's live on production", "Despliegue terminado, ya está en producción")),
        message(ctx, 7, TEAM.priya, 0, say("Nice work, everyone!", "¡Buen trabajo, equipo!"))
    ];
}
