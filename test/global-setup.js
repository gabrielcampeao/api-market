const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const DATABASE_URL = process.env.DATABASE_URL;

module.exports = async function globalSetup() {
  if (!DATABASE_URL) {
    console.log(
      'DATABASE_URL not set - skipping e2e tests (start docker-compose to run them).',
    );
    process.exit(0);
  }

  try {
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`;
    await prisma.$disconnect();
    console.log('Database reachable - running e2e tests.');
  } catch (error) {
    console.log(
      `Database unreachable - skipping e2e tests (${error.message}). ` +
        'Start it with: docker compose up -d postgres redis',
    );
    process.exit(0);
  }
};
