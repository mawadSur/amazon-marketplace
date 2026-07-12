-- Escrow ledger (D4): platform-custody accounting of buyer funds.
-- Additive only — no existing table/column is altered.

-- CreateEnum
CREATE TYPE "EscrowStatus" AS ENUM ('HELD', 'PARTIALLY_RELEASED', 'RELEASED', 'PARTIALLY_REFUNDED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "EscrowEntryType" AS ENUM ('HOLD', 'RELEASE', 'REFUND');

-- CreateTable
CREATE TABLE "escrow" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "status" "EscrowStatus" NOT NULL DEFAULT 'HELD',
    "held_usd_cents" INTEGER NOT NULL DEFAULT 0,
    "released_usd_cents" INTEGER NOT NULL DEFAULT 0,
    "refunded_usd_cents" INTEGER NOT NULL DEFAULT 0,
    "held_at" TIMESTAMP(3),
    "released_at" TIMESTAMP(3),
    "refunded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "escrow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escrow_entries" (
    "id" TEXT NOT NULL,
    "escrow_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "type" "EscrowEntryType" NOT NULL,
    "amount_usd_cents" INTEGER NOT NULL,
    "ref" TEXT NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "escrow_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "escrow_order_id_key" ON "escrow"("order_id");

-- CreateIndex
CREATE INDEX "escrow_status_idx" ON "escrow"("status");

-- CreateIndex
CREATE UNIQUE INDEX "escrow_entries_ref_key" ON "escrow_entries"("ref");

-- CreateIndex
CREATE INDEX "escrow_entries_escrow_id_idx" ON "escrow_entries"("escrow_id");

-- CreateIndex
CREATE INDEX "escrow_entries_order_id_idx" ON "escrow_entries"("order_id");

-- AddForeignKey
ALTER TABLE "escrow" ADD CONSTRAINT "escrow_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escrow_entries" ADD CONSTRAINT "escrow_entries_escrow_id_fkey" FOREIGN KEY ("escrow_id") REFERENCES "escrow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
