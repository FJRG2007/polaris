// The account picker (named people on every link's limits, mentions in rich text)
// searches through a server action, and loading the real one loads the session and
// the environment it validates. Any screen that renders a link's limits reaches it,
// so it answers empty here; a test that needs results mocks it itself.
import { vi } from "vitest";

vi.mock("@/app/(app)/mention-actions", () => ({
    searchAccountsAction: async () => ({ results: [] }),
    searchMentionsAction: async () => ({ results: [] }),
    resolveReferencesAction: async () => ({ labels: {} })
}));
