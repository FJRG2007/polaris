// A direct message reads its disappearing rules through a server action, and
// loading the real one loads the session and the environment it validates.
// Every screen that renders a conversation reaches it, so it answers "no rules"
// here; a test that needs the real actions unmocks it.
import { vi } from "vitest";

vi.mock("@/app/(app)/chat/vanish-actions", () => ({
    directRulesAction: async () => ({ rules: null }),
    setVanishTimerAction: async () => ({}),
    proposeRulesAction: async () => ({}),
    answerProposalAction: async () => ({}),
    hideMessageAction: async () => ({}),
    clearChatAction: async () => ({}),
    deleteChatForAllAction: async () => ({})
}));
