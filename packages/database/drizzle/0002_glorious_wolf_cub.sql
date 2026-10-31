-- rate_limit.last_request stores epoch milliseconds (Better Auth's contract),
-- so the previous timestamptz column is replaced rather than cast.
ALTER TABLE "rate_limit" DROP COLUMN IF EXISTS "last_request";
ALTER TABLE "rate_limit" ADD COLUMN "last_request" bigint;
