-- The address a passkey was registered on. WebAuthn binds a credential to one
-- name and a deployment answers on several, so knowing which one is the
-- difference between offering a passkey and watching the prompt fail. Null on
-- existing rows: those were all issued under the published app address.
ALTER TABLE "Passkey" ADD COLUMN "rpId" TEXT;
