-- `blocks` had no index at all, so every lookup by pane was a full table scan.
-- That scan sat on two hot paths: the retention COUNT(*) that runs on each
-- completed command, and the session restore that runs at startup. On a table
-- holding tens of MB of captured output, both stall the app.
--
-- `is_background` is included because the retention count filters on it, which
-- lets that query be answered from the index alone.
CREATE INDEX IF NOT EXISTS idx_blocks_pane_leaf_uuid ON blocks (pane_leaf_uuid, is_background);

-- History navigation walks backwards and forwards within one session, ordered by
-- id, and command inspection looks a command up by its text and directory.
CREATE INDEX IF NOT EXISTS idx_commands_session_id_id ON commands (session_id, id);
CREATE INDEX IF NOT EXISTS idx_commands_command_pwd ON commands (command, pwd);
