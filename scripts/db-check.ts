import { loadEnv, loadConfig } from '../packages/verification-core/src/index.ts';

async function main() {
  loadEnv();
  const config = loadConfig();
  process.env.DATABASE_URL = config.db.databaseUrl;
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  const users = await prisma.user.count();
  const tables = await prisma.$queryRaw<
    Array<{ name: string }>
  >`SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`;
  console.log(JSON.stringify({ users, tableCount: tables.length, server: 'ok' }));
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
