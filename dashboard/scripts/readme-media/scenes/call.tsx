/** A call coming in: Ana rings while the board is open, and the card says so. */

import { TaskBoard } from "./tasks";
import { defineScene } from "../runtime/scene";
import { TEAM, id } from "../fixtures/people";
import { TASK_LIST_ID } from "../fixtures/tasks";

export const call = defineScene({
    id: "call",
    path: `/tasks/l/${TASK_LIST_ID}`,
    api: () => ({
        // Not picked up anywhere else, so it keeps ringing here.
        "GET /api/chat/meetings/elsewhere": () => ({ call: null })
    }),
    streams: () => ({
        // The frame the chat stream writes when somebody starts a call in a
        // conversation this account is in: Ana's direct messages.
        "/api/chat/stream": [
            {
                type: "message",
                data: {
                    kind: "call",
                    channelId: id("channel", 6),
                    meetingId: id("meeting", 1),
                    state: "ringing",
                    count: 1,
                    userId: TEAM.ana.id,
                    name: TEAM.ana.name
                }
            }
        ]
    }),
    render: (ctx) => <TaskBoard ctx={ctx} />
});
