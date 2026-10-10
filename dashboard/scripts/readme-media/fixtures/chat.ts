/**
 * A small team's chat: one space, its channels and voice rooms, a few direct
 * messages, and the conversations the pictures open.
 *
 * Every message is one Chat really sends: a reply, a forward, a thread, a poll,
 * pictures, a voice note, a recorded call, a code block, the space's own emoji,
 * and the line a deleted message leaves. The files they carry are served from
 * `media/` by the fixture id named here.
 */

import type { SceneContext } from "../runtime/scene";
import { CREW, TEAM, VIEWER, ago, id } from "./people";
import type { ChatProfile } from "@/lib/chat/profiles";
import type { VoicePresence } from "@/lib/chat/meetings";
import type { SpaceEmojiList } from "@/lib/chat/custom-emoji";
import type { ScheduledMessageView } from "@/lib/chat/scheduled";
import type { ChatAttachmentView, ChatMessageView } from "@/lib/chat/messages";
import type { ChatChannelView, ChatSpaceView, ChatCategoryView } from "@/lib/chat/chat-service";

export const SPACE_ID = id("space", 1);
export const CHANNEL_ID = id("channel", 1);
export const GENERAL_ID = id("channel", 2);
export const DESIGN_ID = id("channel", 3);
export const VOICE_ID = id("channel", 5);
export const LOUNGE_ID = id("channel", 8);
export const ANA_DM_ID = id("channel", 6);
export const GROUP_ID = id("channel", 9);

/** The message in #launch the thread hangs off. */
export const THREAD_ROOT_ID = id("message", 3);

/** The space's own emoji. Their pictures are `media/<id>.svg`. */
export const EMOJI = {
    lgtm: id("emoji", 1),
    shipit: id("emoji", 2),
    polaris: id("emoji", 3),
    nice: id("emoji", 4)
} as const;

/** How a message writes one of them, the way the composer does. */
export function emoji(name: keyof typeof EMOJI): string {
    return `<:${name}:${EMOJI[name]}>`;
}

/** Files on the messages below. Pictures and stills are `media/<id>.webp`. */
export const FILES = {
    onboarding: id("attachment", 1),
    board: id("attachment", 2),
    week: id("attachment", 3),
    recording: id("attachment", 4),
    voice: id("attachment", 5),
    brief: id("attachment", 6),
    voiceGrace: id("attachment", 7),
    notes: id("attachment", 8)
} as const;

/** Everybody in the space, the viewer first. */
export const MEMBERS = [VIEWER, ...Object.values(TEAM), ...Object.values(CREW)];

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

const direct = { spaceId: null, categoryId: null } as const;

export function chatChannels(ctx: SceneContext): ChatChannelView[] {
    const say = ctx.say;
    return [
        channel(
            ctx,
            1,
            say("launch", "lanzamiento"),
            say("Everything for the March release", "Todo para la versión de marzo")
        ),
        channel(ctx, 2, say("general", "general"), "", { unread: 3 }),
        channel(
            ctx,
            3,
            say("design", "diseño"),
            say("Screens and reviews", "Pantallas y revisiones")
        ),
        channel(ctx, 4, say("ops", "operaciones"), "", { unread: 1 }),
        channel(ctx, 5, say("standup", "daily"), "", { kind: "voice", userLimit: 10 }),
        channel(ctx, 8, say("lounge", "sala"), "", {
            kind: "voice",
            userLimit: 99,
            categoryId: id("category", 2)
        }),
        channel(ctx, 6, TEAM.ana.name, "", {
            ...direct,
            kind: "dm",
            others: [{ id: TEAM.ana.id, name: TEAM.ana.name }]
        }),
        channel(ctx, 7, TEAM.kenji.name, "", {
            ...direct,
            kind: "dm",
            unread: 2,
            others: [{ id: TEAM.kenji.id, name: TEAM.kenji.name }]
        }),
        channel(ctx, 9, [TEAM.lena, CREW.grace, CREW.mateo].map((one) => one.name).join(", "), "", {
            ...direct,
            kind: "group",
            lastMessageAt: ago(ctx.now, 3),
            others: [TEAM.lena, CREW.grace, CREW.mateo].map(({ id, name }) => ({ id, name }))
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
    return [
        { id: id("category", 1), spaceId: SPACE_ID, name: ctx.say("Channels", "Canales") },
        { id: id("category", 2), spaceId: SPACE_ID, name: ctx.say("Hangout", "Ocio") }
    ];
}

/** Who sits in each voice room right now, as the rail lists them. */
export function voicePresence(): Record<string, VoicePresence[]> {
    const seat = (
        n: number,
        who: { id: string; name: string },
        extra: Partial<VoicePresence> = {}
    ): VoicePresence => ({
        id: id("meeting-seat", n),
        name: who.name,
        userId: who.id,
        muted: false,
        deafened: false,
        streaming: false,
        serverMuted: false,
        serverDeafened: false,
        ...extra
    });
    return {
        [VOICE_ID]: [
            seat(1, VIEWER),
            seat(2, TEAM.ana),
            seat(3, TEAM.priya),
            seat(4, TEAM.kenji),
            seat(5, TEAM.sam, { muted: true })
        ],
        [LOUNGE_ID]: [
            seat(11, CREW.yuki, { streaming: true }),
            seat(12, CREW.mateo),
            seat(13, CREW.grace, { muted: true }),
            seat(14, CREW.omar, { muted: true, deafened: true })
        ]
    };
}

export function spaceEmoji(ctx: SceneContext): SpaceEmojiList {
    return {
        emoji: Object.entries(EMOJI).map(([name, emojiId], index) => ({
            id: emojiId,
            name,
            animated: false,
            uploaderId: TEAM.kenji.id,
            uploaderName: TEAM.kenji.name,
            createdAt: ago(ctx.now, 60 * 24 * (30 - index))
        })),
        manages: true
    };
}

function file(
    fileId: string,
    name: string,
    contentType: string,
    size: number,
    extra: Partial<ChatAttachmentView> = {}
): ChatAttachmentView {
    return {
        id: fileId,
        name,
        size,
        contentType,
        inline: contentType.startsWith("image/"),
        durationMs: null,
        waveform: null,
        hasPoster: false,
        spoiler: false,
        borrowed: false,
        ...extra
    };
}

/** A voice note's shape, one digit a bar, the way the recorder writes it. */
const WAVE = "135797531246897642135798643124687975312468975421357986421357986531";

function voiceNote(fileId: string, seconds: number): ChatAttachmentView {
    return file(fileId, "voice-message.webm", "audio/webm", seconds * 4_000, {
        durationMs: seconds * 1000,
        waveform: WAVE.slice(0, 48)
    });
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

/** #launch, oldest first: what the README's chat opens on. */
export function launchConversation(ctx: SceneContext): ChatMessageView[] {
    const say = ctx.say;
    return [
        message(
            ctx,
            1,
            TEAM.ana,
            52,
            say(
                "Morning! Release candidate is building now.",
                "¡Buenos días! La versión candidata ya se está compilando."
            )
        ),
        message(
            ctx,
            2,
            TEAM.sam,
            47,
            say(
                "Staging is green. I ran the smoke tests twice.",
                "Staging en verde. He pasado las pruebas de humo dos veces."
            ),
            {
                reactions: [
                    { emoji: "\u{1F44D}", count: 3, mine: true },
                    { emoji: emoji("lgtm"), count: 2, mine: false }
                ]
            }
        ),
        message(
            ctx,
            3,
            TEAM.lena,
            31,
            say(
                "The new onboarding screens are in, feedback welcome.",
                "Ya están las nuevas pantallas de bienvenida, se aceptan comentarios."
            ),
            {
                attachments: [file(FILES.onboarding, "onboarding-v2.webp", "image/webp", 184_320)],
                replyCount: 3,
                lastReplyAt: ago(ctx.now, 12)
            }
        ),
        message(
            ctx,
            4,
            VIEWER,
            22,
            say(
                "Looks great. Let's ship it on Thursday after the standup.",
                "Queda genial. Lo publicamos el jueves después de la daily."
            ),
            {
                quote: {
                    id: THREAD_ROOT_ID,
                    channelId: CHANNEL_ID,
                    authorName: TEAM.lena.name,
                    excerpt: say(
                        "The new onboarding screens are in, feedback welcome.",
                        "Ya están las nuevas pantallas de bienvenida, se aceptan comentarios."
                    ),
                    deleted: false,
                    forwarded: false
                }
            }
        ),
        message(
            ctx,
            5,
            TEAM.kenji,
            9,
            say(
                "Release notes come out of the tag, so tag it first:\n\n```bash\nnpm run release -- --tag v2.4.0\n```",
                "Las notas salen de la etiqueta, así que primero etiqueta:\n\n```bash\nnpm run release -- --tag v2.4.0\n```"
            ),
            { reactions: [{ emoji: emoji("shipit"), count: 2, mine: false }] }
        ),
        message(ctx, 6, TEAM.priya, 4, "", { attachments: [voiceNote(FILES.voice, 14)] })
    ];
}

/** What arrives in #launch while the animation plays. */
export function arriving(ctx: SceneContext): ChatMessageView[] {
    const say = ctx.say;
    return [
        message(
            ctx,
            7,
            TEAM.ana,
            1,
            say(
                "Deploy finished, it's live on production",
                "Despliegue terminado, ya está en producción"
            )
        ),
        message(
            ctx,
            8,
            CREW.grace,
            0,
            `${say("Nice work, everyone!", "¡Buen trabajo, equipo!")} ${emoji("polaris")}`
        )
    ];
}

/** The replies under Lena's screens, in the thread beside #launch. */
export function launchThread(ctx: SceneContext): ChatMessageView[] {
    const say = ctx.say;
    const reply = (n: number, who: { id: string; name: string }, minutes: number, body: string) =>
        message(ctx, n, who, minutes, body, { parentId: THREAD_ROOT_ID });
    return [
        launchConversation(ctx)[2]!,
        reply(
            31,
            CREW.grace,
            28,
            say(
                "Love the empty state. Could step two skip the photo upload?",
                "Me encanta el estado vacío. ¿El paso dos puede saltarse la foto?"
            )
        ),
        reply(
            32,
            TEAM.lena,
            20,
            say(
                "Good call, it moves to account settings.",
                "Buena idea, pasa a los ajustes de la cuenta."
            )
        ),
        reply(
            33,
            CREW.mateo,
            12,
            say(
                `Copy reviewed, the Spanish strings are in ${emoji("lgtm")}`,
                `Textos revisados, ya están en español ${emoji("lgtm")}`
            )
        )
    ];
}

/** #design: pictures, a forward from #ops, a file, a recorded review, a voice note. */
export function designConversation(ctx: SceneContext): ChatMessageView[] {
    const say = ctx.say;
    const at = { channelId: DESIGN_ID };
    return [
        message(
            ctx,
            41,
            TEAM.lena,
            120,
            say("Two takes on the board view", "Dos versiones de la vista de tablero"),
            {
                ...at,
                attachments: [
                    file(FILES.board, "board-light.webp", "image/webp", 201_000),
                    file(FILES.week, "week-light.webp", "image/webp", 176_000)
                ]
            }
        ),
        message(
            ctx,
            42,
            CREW.mateo,
            95,
            say("For the storage screens:", "Para las pantallas de almacenamiento:"),
            {
                ...at,
                quote: {
                    id: id("message", 90),
                    channelId: id("channel", 4),
                    authorName: CREW.omar.name,
                    excerpt: say(
                        "Backups ran at 03:00, all 14 volumes verified.",
                        "Las copias se hicieron a las 03:00, los 14 volúmenes verificados."
                    ),
                    deleted: false,
                    forwarded: true
                }
            }
        ),
        message(ctx, 43, CREW.yuki, 70, "", {
            ...at,
            attachments: [file(FILES.brief, "onboarding-brief.pdf", "application/pdf", 254_000)]
        }),
        message(
            ctx,
            44,
            TEAM.kenji,
            40,
            say("Yesterday's design review, recorded.", "La revisión de diseño de ayer, grabada."),
            {
                ...at,
                attachments: [
                    file(FILES.recording, "call-recording.webm", "video/webm", 48_200_000, {
                        hasPoster: true,
                        durationMs: 1_520_000
                    })
                ]
            }
        ),
        message(ctx, 45, CREW.grace, 15, "", {
            ...at,
            attachments: [voiceNote(FILES.voiceGrace, 32)]
        }),
        message(
            ctx,
            46,
            VIEWER,
            6,
            `${say("The second board reads better.", "El segundo tablero se lee mejor.")} ${emoji("nice")}`,
            { ...at, reactions: [{ emoji: "\u{2764}\u{FE0F}", count: 2, mine: false }] }
        )
    ];
}

/** #general: a welcome, a poll, a message somebody took back, an edited one. */
export function generalConversation(ctx: SceneContext): ChatMessageView[] {
    const say = ctx.say;
    const at = { channelId: GENERAL_ID };
    return [
        message(
            ctx,
            51,
            TEAM.priya,
            200,
            say("Welcome to the team, Yuki!", "¡Bienvenida al equipo, Yuki!"),
            {
                ...at,
                reactions: [
                    { emoji: "\u{1F389}", count: 6, mine: true },
                    { emoji: emoji("polaris"), count: 3, mine: false }
                ]
            }
        ),
        message(
            ctx,
            52,
            TEAM.ana,
            90,
            say("Team lunch on Friday. Where?", "Comida de equipo el viernes. ¿Dónde?"),
            {
                ...at,
                kind: "poll",
                poll: {
                    multiple: false,
                    hideResults: false,
                    closed: false,
                    closesAt: new Date(ctx.now + 26 * 60 * 60_000).toISOString(),
                    endedEarly: false,
                    results: true,
                    voters: 8,
                    voted: true,
                    options: [
                        {
                            id: id("poll-option", 1),
                            text: say("Tacos", "Tacos"),
                            votes: 4,
                            mine: true
                        },
                        {
                            id: id("poll-option", 2),
                            text: say("Ramen", "Ramen"),
                            votes: 3,
                            mine: false
                        },
                        {
                            id: id("poll-option", 3),
                            text: say("Pizza", "Pizza"),
                            votes: 1,
                            mine: false
                        }
                    ]
                }
            }
        ),
        message(ctx, 53, TEAM.sam, 60, "", { ...at, deleted: true }),
        message(
            ctx,
            54,
            CREW.omar,
            30,
            say(
                "Reminder: the office is closed on Monday.",
                "Recordatorio: la oficina cierra el lunes."
            ),
            { ...at, edited: true }
        )
    ];
}

/** What the viewer has queued in #general. */
export function generalScheduled(ctx: SceneContext): ScheduledMessageView[] {
    const monday = new Date(ctx.now + 5 * 24 * 60 * 60_000);
    monday.setUTCHours(7, 0, 0, 0);
    return [
        {
            id: id("scheduled", 1),
            channelId: GENERAL_ID,
            body: ctx.say(
                "Good morning! Sprint planning at 10 in the stand-up room.",
                "¡Buenos días! Planificación a las 10 en la sala de la daily."
            ),
            sendAt: monday.toISOString(),
            files: [],
            replying: false,
            failure: null
        }
    ];
}

/** The direct messages with Ana, with the ticks under the viewer's own. */
export function anaConversation(ctx: SceneContext): ChatMessageView[] {
    const say = ctx.say;
    const at = { channelId: ANA_DM_ID };
    return [
        message(
            ctx,
            61,
            TEAM.ana,
            44,
            say("Do you have a minute before the standup?", "¿Tienes un minuto antes de la daily?"),
            at
        ),
        message(ctx, 62, VIEWER, 41, say("Sure, call me.", "Claro, llámame."), {
            ...at,
            receipt: "read"
        }),
        message(
            ctx,
            63,
            TEAM.ana,
            12,
            say(
                "Thanks! Here are the notes we talked about.",
                "¡Gracias! Aquí van las notas de las que hablamos."
            ),
            {
                ...at,
                attachments: [file(FILES.notes, "launch-notes.pdf", "application/pdf", 98_000)]
            }
        ),
        message(ctx, 64, VIEWER, 2, say("Got it, reading now.", "Recibido, lo leo ahora."), {
            ...at,
            receipt: "delivered"
        })
    ];
}

/** The group chat with Lena, Grace and Mateo, just before the call. */
export function groupConversation(ctx: SceneContext): ChatMessageView[] {
    const say = ctx.say;
    const at = { channelId: GROUP_ID };
    return [
        message(
            ctx,
            71,
            TEAM.lena,
            14,
            say(
                "The brand colours are final, can we go over them?",
                "Los colores de marca están cerrados, ¿los repasamos?"
            ),
            at
        ),
        message(
            ctx,
            72,
            CREW.grace,
            13,
            say(
                "Calling now. Alex, can you record it for Yuki?",
                "Llamo ahora. Alex, ¿lo grabas para Yuki?"
            ),
            at
        )
    ];
}

/** The stand-up room's own text chat, beside the call. */
export function standupConversation(ctx: SceneContext): ChatMessageView[] {
    const say = ctx.say;
    const at = { channelId: VOICE_ID };
    return [
        message(
            ctx,
            81,
            TEAM.kenji,
            10,
            say(
                "Agenda: release status, on-call handover, then questions.",
                "Orden del día: estado de la versión, cambio de guardia y preguntas."
            ),
            at
        ),
        message(
            ctx,
            82,
            TEAM.priya,
            6,
            say(
                "Status page is ready to flip on Thursday.",
                "La página de estado está lista para el jueves."
            ),
            { ...at, reactions: [{ emoji: emoji("lgtm"), count: 3, mine: true }] }
        )
    ];
}

/** Somebody's profile as the panel beside a direct message draws it. */
export function profileOf(ctx: SceneContext, userId: string): ChatProfile {
    const who = MEMBERS.find((one) => one.id === userId) ?? TEAM.ana;
    const handle = who.email.split("@")[0]!;
    return {
        name: who.name,
        fullName: who.name,
        username: handle,
        description: ctx.say(
            "Backend and the release train. Ask me about the import pipeline.",
            "Backend y el tren de versiones. Pregúntame por la importación."
        ),
        headline: ctx.say("Engineering lead at Northwind", "Jefa de ingeniería en Northwind"),
        pronouns: ctx.say("she/her", "ella"),
        mutual: {
            friends: {
                people: [TEAM.kenji, TEAM.priya].map((one) => ({
                    id: one.id,
                    name: one.name,
                    username: one.email.split("@")[0]!
                })),
                total: 2
            },
            spaces: {
                spaces: [{ id: SPACE_ID, name: chatSpaces(ctx)[0]!.name, color: "#6366f1" }],
                total: 1
            }
        },
        role: null
    };
}

/** Who is in a conversation: everybody in the space for a channel, the people
 *  in it for a direct message or a group. */
export function membersOf(ctx: SceneContext, channelId: string) {
    const found = chatChannels(ctx).find((one) => one.id === channelId);
    if (!found || found.spaceId) return MEMBERS;
    const ids = new Set(found.others.map((one) => one.id));
    return [VIEWER, ...MEMBERS.filter((one) => ids.has(one.id))];
}

/** Each conversation a scene opens, by channel. */
export function conversation(ctx: SceneContext, channelId: string): ChatMessageView[] {
    if (channelId === DESIGN_ID) return designConversation(ctx);
    if (channelId === GENERAL_ID) return generalConversation(ctx);
    if (channelId === ANA_DM_ID) return anaConversation(ctx);
    if (channelId === CHANNEL_ID) return launchConversation(ctx);
    if (channelId === GROUP_ID) return groupConversation(ctx);
    if (channelId === VOICE_ID) return standupConversation(ctx);
    return [];
}
