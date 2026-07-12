-- Wave 2: per-shop disputes, per-item order status, scheduled payouts.
-- All additive. Note: disputes.shop_id is added NOT NULL with no default; on an
-- environment with pre-existing dispute rows, backfill shop_id before applying.

-- CreateEnum
CREATE TYPE "OrderItemStatus" AS ENUM ('ACTIVE', 'DISPUTED', 'REFUNDED');

-- DropIndex
DROP INDEX "disputes_order_id_key";

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "status" "OrderItemStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "payouts" ADD COLUMN     "disbursed_at" TIMESTAMP(3),
ADD COLUMN     "eligible_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "disputes" ADD COLUMN     "order_item_ids" TEXT[],
ADD COLUMN     "shop_id" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "order_items_order_id_status_idx" ON "order_items"("order_id", "status");

-- CreateIndex
CREATE INDEX "payouts_status_eligible_at_idx" ON "payouts"("status", "eligible_at");

-- CreateIndex
CREATE INDEX "disputes_shop_id_idx" ON "disputes"("shop_id");

-- CreateIndex
CREATE UNIQUE INDEX "disputes_order_id_shop_id_key" ON "disputes"("order_id", "shop_id");

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
