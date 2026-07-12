-- Escrow ledger fix: track the seller-releasable portion (order subtotal) so the
-- RELEASED status is reachable. The full held total includes the platform cut
-- (fee + shipping + duty) which is never released, so RELEASED is keyed off this
-- column, not held_usd_cents. Additive only — no existing column is altered.

-- AlterTable
ALTER TABLE "escrow" ADD COLUMN "releasable_usd_cents" INTEGER NOT NULL DEFAULT 0;
