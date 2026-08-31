-- CreateIndex
CREATE INDEX "AgentSession_startedById_state_idx" ON "AgentSession"("startedById", "state");

-- CreateIndex
CREATE INDEX "AgentSession_state_lastEventAt_idx" ON "AgentSession"("state", "lastEventAt");

