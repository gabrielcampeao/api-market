-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'PROCESSING';

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "processing_at" TIMESTAMP(3);
