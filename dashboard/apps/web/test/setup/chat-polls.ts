// The chat screen's timed reads go through routes (see `chat/chat-polls`), but
// the screen tests drive what those reads return by mocking the action modules
// the reads used to call. Forward to whatever a test file mocked there, so each
// file keeps saying what the server answers in one place. A file that mocks
// neither gets empty answers, never a network call. The routes themselves are
// tested on their own, in `test/chat/chat-poll-routes.test.ts`.
import { vi } from "vitest";

vi.mock("@/app/(app)/chat/chat-polls", () => ({
    fetchVoicePresence: async (ids: readonly string[]) => {
        try {
            const actions = (await import("@/app/(app)/chat/actions")) as unknown as {
                voicePresenceAction?: (ids: string[]) => Promise<{ inRoom: object }>;
            };
            return (await actions.voicePresenceAction?.([...ids]))?.inRoom ?? {};
        } catch {
            return {};
        }
    },
    fetchLiveCall: async (channelId: string) => {
        try {
            const calls = (await import("@/app/(app)/chat/meeting-actions")) as unknown as {
                liveCallAction?: (id: string) => Promise<unknown>;
            };
            return (await calls.liveCallAction?.(channelId)) ?? null;
        } catch {
            return null;
        }
    }
}));
