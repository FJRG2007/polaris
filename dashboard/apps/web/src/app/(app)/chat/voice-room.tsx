"use client";

/**
 * A voice channel, open.
 *
 * A room rather than a record: there is no message list here and nothing to
 * scroll back through. Walking in is joining the call that is already there, and
 * walking out is leaving it - which is what a voice channel is everywhere else,
 * and the reason it is worth having as its own kind of channel rather than as a
 * button in a text one.
 *
 * Joining is deliberately not automatic. A room that opened your microphone
 * because you clicked its name in a list is a room people are afraid to click,
 * and the one time it matters is the time somebody was only looking.
 */

import { useState } from "react";
import { Button } from "@polaris/ui";
import { CallRoom } from "./call-room";
import { useChat } from "./chat-context";
import * as calls from "./meeting-actions";
import { runAction } from "@/lib/run-action";
import { ChannelHeader } from "./channel-header";
import { Mic, Video, Volume2 } from "lucide-react";
import type { ChatChannelView } from "@/lib/chat/chat-service";

export function VoiceRoom({ channel }: { channel: ChatChannelView }) {
    const { viewerId, refresh } = useChat();
    const [meetingId, setMeetingId] = useState<string | null>(null);
    const [withVideo, setWithVideo] = useState(false);
    const [error, setError] = useState("");

    const join = async (video: boolean) => {
        const result = await runAction(() => calls.startCallAction(channel.id), setError);
        if (result?.error || !result?.meetingId) return;
        setWithVideo(video);
        setMeetingId(result.meetingId);
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <ChannelHeader
                channel={channel}
                onChanged={refresh}
                call={null}
                // The header's own call buttons would be a second way into the
                // room you are already looking at.
                onStartCall={(video) => void join(video)}
            />

            {error && (
                <p role="alert" className="border-b border-border px-4 py-1 text-xs text-destructive">
                    {error}
                </p>
            )}

            {meetingId ? (
                <CallRoom
                    meetingId={meetingId}
                    withVideo={withVideo}
                    viewerId={viewerId}
                    onLeave={() => setMeetingId(null)}
                />
            ) : (
                <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
                    <Volume2 className="size-8 text-muted-foreground" />
                    <div>
                        <p className="text-sm font-medium">{channel.name}</p>
                        <p className="text-xs text-muted-foreground">
                            {channel.topic || "Nobody is told you are here until you join."}
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button size="sm" onClick={() => void join(false)}>
                            <Mic className="size-4" />
                            Join
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => void join(true)}>
                            <Video className="size-4" />
                            Join with video
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}
