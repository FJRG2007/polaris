-- Profile photos.
--
-- An account's face was previously always its initials. It can now be a photo
-- the person uploaded, and failing that whatever Gravatar has for the address
-- they sign in with - initials remain the answer when there is neither, so a
-- fresh instance looks exactly as it did.
--
-- Only the uploaded case needs a row. The bytes go to whatever storage the
-- instance keeps uploads on (a NAS if it has one, its own disk otherwise), and
-- this records which one and where, so a photo written before a NAS was
-- connected stays readable on the disk it was written to.
--
-- connectionId deliberately has no foreign key, for the same reason
-- TaskAttachment.connectionId has none: a storage connection can be removed
-- while files it holds are still described here, and a pointer that cannot be
-- resolved is more honest than a row that vanished with the connection.
--
-- One row per account (userId is the primary key): replacing a photo replaces
-- the row rather than piling up versions nobody asked for.

-- CreateTable
CREATE TABLE "UserAvatar" (
    "userId" UUID NOT NULL,
    "connectionId" TEXT,
    "path" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserAvatar_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "UserAvatar" ADD CONSTRAINT "UserAvatar_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
