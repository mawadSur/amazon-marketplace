-- AlterEnum
ALTER TYPE "PayoutStatus" ADD VALUE 'REVERSED';

-- AlterTable
ALTER TABLE "payouts" ADD COLUMN     "order_id" TEXT,
ADD COLUMN     "reversal_id" TEXT,
ADD COLUMN     "reversed_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "payout_reversals" (
    "id" TEXT NOT NULL,
    "payout_id" TEXT NOT NULL,
    "amount_inr_paise" INTEGER NOT NULL,
    "reason" TEXT,
    "reversal_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_reversals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_webhook_events" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "order_id" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payout_reversals_payout_id_idx" ON "payout_reversals"("payout_id");

-- CreateIndex
CREATE INDEX "processed_webhook_events_order_id_idx" ON "processed_webhook_events"("order_id");

-- CreateIndex
CREATE INDEX "categories_parent_id_idx" ON "categories"("parent_id");

-- CreateIndex
CREATE INDEX "products_category_id_idx" ON "products"("category_id");

-- CreateIndex
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");

-- CreateIndex
CREATE INDEX "order_items_product_id_idx" ON "order_items"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "payouts_order_id_shop_id_key" ON "payouts"("order_id", "shop_id");

-- AddForeignKey
ALTER TABLE "payout_reversals" ADD CONSTRAINT "payout_reversals_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "payouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

