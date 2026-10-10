/** In a call with the soundboard open: Polaris's own sounds and the space's. */

import { inCall } from "./in-call";
import { defineScene } from "../runtime/scene";
import { label, press } from "../runtime/interact";
import { ago, id, TEAM } from "../fixtures/people";
import { SPACE_ID, chatSpaces } from "../fixtures/chat";

export const soundboard = defineScene({
    id: "soundboard",
    path: inCall.path,
    params: inCall.params,
    actions: (ctx) => {
        const sound = (n: number, en: string, es: string, emoji: string, minutes: number) => ({
            id: id("sound", n),
            spaceId: SPACE_ID,
            name: ctx.say(en, es),
            emoji,
            volume: 1,
            durationMs: 2_400,
            uploaderName: TEAM.ana.name,
            createdAt: ago(ctx.now, minutes)
        });
        return {
            ...inCall.actions!(ctx),
            callSoundboardAction: () => ({
                board: {
                    refusal: null,
                    external: true,
                    groups: [
                        {
                            spaceId: SPACE_ID,
                            spaceName: chatSpaces(ctx)[0]!.name,
                            here: true,
                            sounds: [
                                sound(1, "Ship it", "A producción", "\u{1F680}", 900),
                                sound(2, "Standup bell", "Campana daily", "\u{1F514}", 800),
                                sound(3, "Coffee break", "Hora del café", "☕", 700),
                                sound(4, "Nice catch", "Bien visto", "\u{1F3AF}", 600),
                                sound(5, "Drumroll", "Redoble", "\u{1F941}", 500)
                            ]
                        }
                    ],
                    favorites: ["default:applause", id("sound", 1)],
                    manageSpaceId: SPACE_ID,
                    cooldownMs: 3_000
                }
            })
        };
    },
    render: inCall.render,
    prepare: (ctx) => press(label(ctx.locale, "chat.soundboard.button"))
});
