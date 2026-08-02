-- The Tasks app: work management as a first-class Polaris pillar.
--
-- The hierarchy is Space > Folder > List > Task > Subtask. A space owns the
-- vocabulary its lists share (statuses, tags, custom fields, sprints) so two
-- teams on one instance can run different processes without agreeing on a single
-- set of columns, and a list owns the work itself - a task cannot exist outside
-- one, which is what makes the list the unit that carries views, automations and
-- intake forms.
--
-- Three choices here are worth stating rather than rediscovering:
--
--   * Task.spaceId sits alongside Task.listId. The reference counter, the tag
--     and field vocabulary, and every cross-list view are space-scoped, and
--     reaching the space through the list on each of those reads costs more than
--     the column does. The trade is that a task moves between lists in its space
--     and never between spaces, which is also what keeps its reference stable.
--   * Statuses are space-level, not per-list. A board people drag work across
--     has to mean the same thing everywhere, and per-list overrides are how a
--     workspace ends up with nine spellings of "Done".
--   * Manual order is a sparse double rather than a dense integer, so a drag
--     writes one row instead of renumbering everything below it.
--
-- Everything JSON-shaped (filters, automation actions, form questions,
-- recurrence, field settings) is a stringified String column, keeping the schema
-- SQLite-portable exactly as the rest of the model is.

-- CreateTable
CREATE TABLE "TaskSpace" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "color" TEXT NOT NULL DEFAULT '#7c5cff',
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "order" DOUBLE PRECISION NOT NULL DEFAULT 1024,
    "taskCounter" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskSpace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskSpaceMember" (
    "id" UUID NOT NULL,
    "spaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskSpaceMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskFolder" (
    "id" UUID NOT NULL,
    "spaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "order" DOUBLE PRECISION NOT NULL DEFAULT 1024,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskFolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskList" (
    "id" UUID NOT NULL,
    "spaceId" UUID NOT NULL,
    "folderId" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "color" TEXT,
    "startDate" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "order" DOUBLE PRECISION NOT NULL DEFAULT 1024,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskStatus" (
    "id" UUID NOT NULL,
    "spaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'open',
    "color" TEXT NOT NULL DEFAULT '#64748b',
    "order" DOUBLE PRECISION NOT NULL DEFAULT 1024,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskStatus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskTag" (
    "id" UUID NOT NULL,
    "spaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#7c5cff',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskCustomField" (
    "id" UUID NOT NULL,
    "spaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "config" TEXT NOT NULL DEFAULT '{}',
    "required" BOOLEAN NOT NULL DEFAULT false,
    "showOnCard" BOOLEAN NOT NULL DEFAULT false,
    "order" DOUBLE PRECISION NOT NULL DEFAULT 1024,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskCustomField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" UUID NOT NULL,
    "spaceId" UUID NOT NULL,
    "listId" UUID NOT NULL,
    "parentId" UUID,
    "number" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "statusId" UUID,
    "priority" TEXT NOT NULL DEFAULT 'none',
    "startDate" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "timed" BOOLEAN NOT NULL DEFAULT false,
    "timeEstimate" INTEGER,
    "points" INTEGER,
    "milestone" BOOLEAN NOT NULL DEFAULT false,
    "order" DOUBLE PRECISION NOT NULL DEFAULT 1024,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMP(3),
    "sprintId" UUID,
    "recurrence" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskAssignee" (
    "taskId" UUID NOT NULL,
    "userId" UUID NOT NULL,

    CONSTRAINT "TaskAssignee_pkey" PRIMARY KEY ("taskId","userId")
);

-- CreateTable
CREATE TABLE "TaskWatcher" (
    "taskId" UUID NOT NULL,
    "userId" UUID NOT NULL,

    CONSTRAINT "TaskWatcher_pkey" PRIMARY KEY ("taskId","userId")
);

-- CreateTable
CREATE TABLE "TaskTagLink" (
    "taskId" UUID NOT NULL,
    "tagId" UUID NOT NULL,

    CONSTRAINT "TaskTagLink_pkey" PRIMARY KEY ("taskId","tagId")
);

-- CreateTable
CREATE TABLE "TaskCustomFieldValue" (
    "taskId" UUID NOT NULL,
    "fieldId" UUID NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "TaskCustomFieldValue_pkey" PRIMARY KEY ("taskId","fieldId")
);

-- CreateTable
CREATE TABLE "TaskComment" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "parentId" UUID,
    "userId" UUID,
    "body" TEXT NOT NULL,
    "assignedToId" UUID,
    "resolvedById" UUID,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskChecklist" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "order" DOUBLE PRECISION NOT NULL DEFAULT 1024,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskChecklist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskChecklistItem" (
    "id" UUID NOT NULL,
    "checklistId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "doneAt" TIMESTAMP(3),
    "assigneeId" UUID,
    "order" DOUBLE PRECISION NOT NULL DEFAULT 1024,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskDependency" (
    "id" UUID NOT NULL,
    "blockerId" UUID NOT NULL,
    "blockedId" UUID NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'blocks',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskDependency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskTimeEntry" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "seconds" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT NOT NULL DEFAULT '',
    "billable" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskTimeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskActivity" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "userId" UUID,
    "action" TEXT NOT NULL,
    "fromValue" TEXT,
    "toValue" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskView" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "listId" UUID,
    "spaceId" UUID,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'list',
    "groupBy" TEXT NOT NULL DEFAULT 'status',
    "sortField" TEXT NOT NULL DEFAULT 'manual',
    "sortDirection" TEXT NOT NULL DEFAULT 'asc',
    "filter" TEXT NOT NULL DEFAULT '{}',
    "columns" TEXT NOT NULL DEFAULT '[]',
    "showSubtasks" BOOLEAN NOT NULL DEFAULT true,
    "showClosed" BOOLEAN NOT NULL DEFAULT false,
    "shared" BOOLEAN NOT NULL DEFAULT true,
    "order" DOUBLE PRECISION NOT NULL DEFAULT 1024,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskSprint" (
    "id" UUID NOT NULL,
    "spaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "goal" TEXT NOT NULL DEFAULT '',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskSprint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskGoal" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "spaceId" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "dueDate" TIMESTAMP(3),
    "color" TEXT NOT NULL DEFAULT '#7c5cff',
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskGoal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskGoalTarget" (
    "id" UUID NOT NULL,
    "goalId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'number',
    "startValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "targetValue" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "currentValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL DEFAULT '',
    "listId" UUID,
    "order" DOUBLE PRECISION NOT NULL DEFAULT 1024,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskGoalTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskAutomation" (
    "id" UUID NOT NULL,
    "spaceId" UUID NOT NULL,
    "listId" UUID,
    "name" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "conditions" TEXT NOT NULL DEFAULT '{}',
    "actions" TEXT NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "lastRunAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskAutomation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskTemplate" (
    "id" UUID NOT NULL,
    "spaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskForm" (
    "id" UUID NOT NULL,
    "spaceId" UUID NOT NULL,
    "listId" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "intro" TEXT NOT NULL DEFAULT '',
    "fields" TEXT NOT NULL DEFAULT '[]',
    "defaultStatusId" UUID,
    "confirmation" TEXT NOT NULL DEFAULT '',
    "requireLogin" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskForm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskFormSubmission" (
    "id" UUID NOT NULL,
    "formId" UUID NOT NULL,
    "taskId" UUID,
    "answers" TEXT NOT NULL DEFAULT '{}',
    "submittedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskFormSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskReminder" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "remindAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskReminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskDoc" (
    "id" UUID NOT NULL,
    "spaceId" UUID,
    "parentId" UUID,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "icon" TEXT NOT NULL DEFAULT '',
    "order" DOUBLE PRECISION NOT NULL DEFAULT 1024,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskDoc_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaskSpace_prefix_key" ON "TaskSpace"("prefix");

-- CreateIndex
CREATE INDEX "TaskSpace_ownerId_idx" ON "TaskSpace"("ownerId");

-- CreateIndex
CREATE INDEX "TaskSpaceMember_userId_idx" ON "TaskSpaceMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskSpaceMember_spaceId_userId_key" ON "TaskSpaceMember"("spaceId", "userId");

-- CreateIndex
CREATE INDEX "TaskFolder_spaceId_idx" ON "TaskFolder"("spaceId");

-- CreateIndex
CREATE INDEX "TaskList_spaceId_idx" ON "TaskList"("spaceId");

-- CreateIndex
CREATE INDEX "TaskList_folderId_idx" ON "TaskList"("folderId");

-- CreateIndex
CREATE INDEX "TaskStatus_spaceId_idx" ON "TaskStatus"("spaceId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskTag_spaceId_name_key" ON "TaskTag"("spaceId", "name");

-- CreateIndex
CREATE INDEX "TaskCustomField_spaceId_idx" ON "TaskCustomField"("spaceId");

-- CreateIndex
CREATE INDEX "Task_listId_idx" ON "Task"("listId");

-- CreateIndex
CREATE INDEX "Task_spaceId_archived_idx" ON "Task"("spaceId", "archived");

-- CreateIndex
CREATE INDEX "Task_statusId_idx" ON "Task"("statusId");

-- CreateIndex
CREATE INDEX "Task_parentId_idx" ON "Task"("parentId");

-- CreateIndex
CREATE INDEX "Task_sprintId_idx" ON "Task"("sprintId");

-- CreateIndex
CREATE INDEX "Task_dueDate_idx" ON "Task"("dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "Task_spaceId_number_key" ON "Task"("spaceId", "number");

-- CreateIndex
CREATE INDEX "TaskAssignee_userId_idx" ON "TaskAssignee"("userId");

-- CreateIndex
CREATE INDEX "TaskWatcher_userId_idx" ON "TaskWatcher"("userId");

-- CreateIndex
CREATE INDEX "TaskTagLink_tagId_idx" ON "TaskTagLink"("tagId");

-- CreateIndex
CREATE INDEX "TaskCustomFieldValue_fieldId_idx" ON "TaskCustomFieldValue"("fieldId");

-- CreateIndex
CREATE INDEX "TaskComment_taskId_createdAt_idx" ON "TaskComment"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "TaskComment_parentId_idx" ON "TaskComment"("parentId");

-- CreateIndex
CREATE INDEX "TaskChecklist_taskId_idx" ON "TaskChecklist"("taskId");

-- CreateIndex
CREATE INDEX "TaskChecklistItem_checklistId_idx" ON "TaskChecklistItem"("checklistId");

-- CreateIndex
CREATE INDEX "TaskDependency_blockedId_idx" ON "TaskDependency"("blockedId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskDependency_blockerId_blockedId_type_key" ON "TaskDependency"("blockerId", "blockedId", "type");

-- CreateIndex
CREATE INDEX "TaskTimeEntry_taskId_idx" ON "TaskTimeEntry"("taskId");

-- CreateIndex
CREATE INDEX "TaskTimeEntry_userId_startedAt_idx" ON "TaskTimeEntry"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "TaskActivity_taskId_createdAt_idx" ON "TaskActivity"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "TaskView_listId_idx" ON "TaskView"("listId");

-- CreateIndex
CREATE INDEX "TaskView_spaceId_idx" ON "TaskView"("spaceId");

-- CreateIndex
CREATE INDEX "TaskView_ownerId_idx" ON "TaskView"("ownerId");

-- CreateIndex
CREATE INDEX "TaskSprint_spaceId_idx" ON "TaskSprint"("spaceId");

-- CreateIndex
CREATE INDEX "TaskGoal_ownerId_idx" ON "TaskGoal"("ownerId");

-- CreateIndex
CREATE INDEX "TaskGoal_spaceId_idx" ON "TaskGoal"("spaceId");

-- CreateIndex
CREATE INDEX "TaskGoalTarget_goalId_idx" ON "TaskGoalTarget"("goalId");

-- CreateIndex
CREATE INDEX "TaskGoalTarget_listId_idx" ON "TaskGoalTarget"("listId");

-- CreateIndex
CREATE INDEX "TaskAutomation_spaceId_idx" ON "TaskAutomation"("spaceId");

-- CreateIndex
CREATE INDEX "TaskAutomation_listId_idx" ON "TaskAutomation"("listId");

-- CreateIndex
CREATE INDEX "TaskTemplate_spaceId_idx" ON "TaskTemplate"("spaceId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskForm_token_key" ON "TaskForm"("token");

-- CreateIndex
CREATE INDEX "TaskForm_listId_idx" ON "TaskForm"("listId");

-- CreateIndex
CREATE INDEX "TaskForm_spaceId_idx" ON "TaskForm"("spaceId");

-- CreateIndex
CREATE INDEX "TaskFormSubmission_formId_createdAt_idx" ON "TaskFormSubmission"("formId", "createdAt");

-- CreateIndex
CREATE INDEX "TaskReminder_userId_remindAt_idx" ON "TaskReminder"("userId", "remindAt");

-- CreateIndex
CREATE INDEX "TaskReminder_taskId_idx" ON "TaskReminder"("taskId");

-- CreateIndex
CREATE INDEX "TaskDoc_spaceId_idx" ON "TaskDoc"("spaceId");

-- CreateIndex
CREATE INDEX "TaskDoc_parentId_idx" ON "TaskDoc"("parentId");

-- AddForeignKey
ALTER TABLE "TaskSpace" ADD CONSTRAINT "TaskSpace_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskSpaceMember" ADD CONSTRAINT "TaskSpaceMember_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "TaskSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskSpaceMember" ADD CONSTRAINT "TaskSpaceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskFolder" ADD CONSTRAINT "TaskFolder_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "TaskSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskList" ADD CONSTRAINT "TaskList_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "TaskSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskList" ADD CONSTRAINT "TaskList_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "TaskFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskStatus" ADD CONSTRAINT "TaskStatus_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "TaskSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskTag" ADD CONSTRAINT "TaskTag_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "TaskSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskCustomField" ADD CONSTRAINT "TaskCustomField_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "TaskSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "TaskSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_listId_fkey" FOREIGN KEY ("listId") REFERENCES "TaskList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_statusId_fkey" FOREIGN KEY ("statusId") REFERENCES "TaskStatus"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_sprintId_fkey" FOREIGN KEY ("sprintId") REFERENCES "TaskSprint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAssignee" ADD CONSTRAINT "TaskAssignee_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAssignee" ADD CONSTRAINT "TaskAssignee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskWatcher" ADD CONSTRAINT "TaskWatcher_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskWatcher" ADD CONSTRAINT "TaskWatcher_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskTagLink" ADD CONSTRAINT "TaskTagLink_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskTagLink" ADD CONSTRAINT "TaskTagLink_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "TaskTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskCustomFieldValue" ADD CONSTRAINT "TaskCustomFieldValue_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskCustomFieldValue" ADD CONSTRAINT "TaskCustomFieldValue_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "TaskCustomField"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskComment" ADD CONSTRAINT "TaskComment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskComment" ADD CONSTRAINT "TaskComment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskComment" ADD CONSTRAINT "TaskComment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "TaskComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskChecklist" ADD CONSTRAINT "TaskChecklist_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskChecklistItem" ADD CONSTRAINT "TaskChecklistItem_checklistId_fkey" FOREIGN KEY ("checklistId") REFERENCES "TaskChecklist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskDependency" ADD CONSTRAINT "TaskDependency_blockerId_fkey" FOREIGN KEY ("blockerId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskDependency" ADD CONSTRAINT "TaskDependency_blockedId_fkey" FOREIGN KEY ("blockedId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskTimeEntry" ADD CONSTRAINT "TaskTimeEntry_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskTimeEntry" ADD CONSTRAINT "TaskTimeEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskActivity" ADD CONSTRAINT "TaskActivity_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskView" ADD CONSTRAINT "TaskView_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskView" ADD CONSTRAINT "TaskView_listId_fkey" FOREIGN KEY ("listId") REFERENCES "TaskList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskView" ADD CONSTRAINT "TaskView_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "TaskSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskSprint" ADD CONSTRAINT "TaskSprint_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "TaskSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskGoal" ADD CONSTRAINT "TaskGoal_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskGoal" ADD CONSTRAINT "TaskGoal_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "TaskSpace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskGoalTarget" ADD CONSTRAINT "TaskGoalTarget_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "TaskGoal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskGoalTarget" ADD CONSTRAINT "TaskGoalTarget_listId_fkey" FOREIGN KEY ("listId") REFERENCES "TaskList"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAutomation" ADD CONSTRAINT "TaskAutomation_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "TaskSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAutomation" ADD CONSTRAINT "TaskAutomation_listId_fkey" FOREIGN KEY ("listId") REFERENCES "TaskList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskTemplate" ADD CONSTRAINT "TaskTemplate_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "TaskSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskForm" ADD CONSTRAINT "TaskForm_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "TaskSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskForm" ADD CONSTRAINT "TaskForm_listId_fkey" FOREIGN KEY ("listId") REFERENCES "TaskList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskFormSubmission" ADD CONSTRAINT "TaskFormSubmission_formId_fkey" FOREIGN KEY ("formId") REFERENCES "TaskForm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskFormSubmission" ADD CONSTRAINT "TaskFormSubmission_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskReminder" ADD CONSTRAINT "TaskReminder_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskReminder" ADD CONSTRAINT "TaskReminder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskDoc" ADD CONSTRAINT "TaskDoc_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "TaskSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskDoc" ADD CONSTRAINT "TaskDoc_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "TaskDoc"("id") ON DELETE CASCADE ON UPDATE CASCADE;
