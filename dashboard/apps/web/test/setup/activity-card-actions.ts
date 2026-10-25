// The card a call's game shows in its conversation reads itself through a server
// action, and loading the real one loads the session and the environment it
// validates. Every screen that renders a message list reaches it, so it answers
// empty here; a test that needs the real actions unmocks it.
import { vi } from "vitest";

vi.mock("@/app/(app)/chat/activity-card-actions", () => ({
    readActivityCard: async () => null,
    gameInviteAccess: async () => ({ ok: false, reason: "denied" }),
    gameInviteTargets: async () => [],
    inviteToGame: async () => ({ ok: false, reason: "denied" })
}));
