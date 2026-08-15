-- One capability switched on or off for one account, regardless of their role.
--
-- A statement source beside roles and policies, not a field that shadows them:
-- allow or deny, resolved by the same engine, so an explicit deny beats every
-- allow underneath it exactly as it does anywhere else. No row means the account
-- falls through to whatever their role and policies say - which is why absence
-- is not deny, and the screen offers three states rather than a checkbox.
--
-- New table only. An instance with no overrides behaves exactly as before.

-- CreateTable
CREATE TABLE "UserPermission" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "permission" TEXT NOT NULL,
    "effect" TEXT NOT NULL,
    "setById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPermission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserPermission_userId_idx" ON "UserPermission"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserPermission_userId_permission_key" ON "UserPermission"("userId", "permission");

-- AddForeignKey
ALTER TABLE "UserPermission" ADD CONSTRAINT "UserPermission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

