/**
 * Idempotent seed for ZetHub Proof.
 *
 * It does not create accounts or demo data. Accounts are created through the
 * first-run bootstrap screen, which enforces the password policy. This seed
 * only repairs missing per-user settings rows so existing installations keep
 * working after schema upgrades.
 */
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { UserSettingsSchema } from '@zethub/shared-types';

loadDotenv({ path: path.resolve(import.meta.dirname, '..', '.env') });

if (!process.env.DATABASE_URL) {
  process.stderr.write('DATABASE_URL is not set. Run `npm run db:setup` or configure .env first.\n');
  process.exit(1);
}

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const defaults = UserSettingsSchema.parse({});
  const users = await prisma.user.findMany({ select: { id: true, email: true, settings: { select: { id: true } } } });
  let created = 0;
  for (const user of users) {
    if (user.settings) continue;
    await prisma.userSetting.create({ data: { userId: user.id, settingsJson: defaults } });
    created += 1;
  }
  process.stdout.write(
    JSON.stringify(
      {
        users: users.length,
        settingsCreated: created,
        note:
          users.length === 0
            ? 'No account exists yet. Open the app and complete first-run setup.'
            : 'Existing accounts preserved.',
      },
      null,
      2,
    ) + '\n',
  );
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`Seed failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
