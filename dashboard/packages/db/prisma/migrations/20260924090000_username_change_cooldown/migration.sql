-- When this account last took a different username.
--
-- A handle is how other people find and address somebody here: it is on their
-- profile, it is what a game server's allow-list was keyed to, and it is what
-- somebody types to start a conversation. An account that can change it whenever
-- it likes can walk away from all of that on a whim, and can do it repeatedly
-- enough that nobody can rely on the name they saw yesterday.
--
-- So a change costs a waiting period, the way it does on Discord, Instagram and
-- most platforms where a handle means anything. This column is what the wait is
-- measured from.
--
-- Null on every account that exists today, which reads as "has never changed it"
-- and lets each of them make one change straight away. Deliberate: nobody should
-- be serving a wait that was imposed retroactively for something they did before
-- the rule existed.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "usernameChangedAt" TIMESTAMP(3);
