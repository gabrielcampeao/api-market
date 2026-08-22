import 'reflect-metadata';
import { PrismaClient, Role } from '@prisma/client';
import { hashPassword } from '../src/common/utils/password.util';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const email = (process.env.ADMIN_EMAIL ?? 'admin@marketplace.dev').toLowerCase();
  const password = process.env.ADMIN_PASSWORD ?? 'Admin123!';
  const name = process.env.ADMIN_NAME ?? 'Admin';

  const passwordHash = await hashPassword(password);

  const admin = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, name, passwordHash, role: Role.ADMIN },
  });
  console.log(`Admin user ready: ${admin.email} (${admin.role})`);

  const products = [
    { name: 'Wireless Mouse', description: 'Ergonomic 2.4GHz wireless mouse', price: '29.90', stock: 100 },
    { name: 'Mechanical Keyboard', description: 'RGB mechanical keyboard with brown switches', price: '199.90', stock: 50 },
    { name: '27" 4K Monitor', description: 'UHD IPS monitor with USB-C', price: '1499.90', stock: 20 },
    { name: 'USB-C Hub', description: '7-in-1 aluminium hub with HDMI', price: '89.90', stock: 80 },
    { name: 'Laptop Stand', description: 'Aluminium adjustable stand', price: '129.90', stock: 60 },
  ];

  for (const p of products) {
    const existing = await prisma.product.findFirst({ where: { name: p.name } });
    if (!existing) {
      await prisma.product.create({ data: p });
    }
  }
  console.log(`Seeded ${products.length} products`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
