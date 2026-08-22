-- DropIndex
DROP INDEX "products_name_idx";

-- Prisma's schema DSL has no CHECK constraint primitive, so these are
-- hand-written. Trade-off: `prisma db pull`/schema drift detection won't
-- see them — they only exist here, in the migration history. Each one
-- guards an invariant the application already enforces (DTO validation,
-- conditional updateMany claims for stock/payment) but that a bug in that
-- application-level logic — or a manual `UPDATE` run outside the app —
-- could otherwise violate silently.
ALTER TABLE "products" ADD CONSTRAINT "products_price_nonnegative" CHECK ("price" >= 0);
ALTER TABLE "products" ADD CONSTRAINT "products_stock_nonnegative" CHECK ("stock" >= 0);
ALTER TABLE "orders" ADD CONSTRAINT "orders_total_nonnegative" CHECK ("total" >= 0);
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_price_nonnegative" CHECK ("price" >= 0);
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_nonnegative" CHECK ("amount" >= 0);
