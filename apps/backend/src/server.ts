import { buildApp } from './app.js';
import { config } from './config.js';
import { checkDatabase, disconnectDatabase, schemaState } from './db.js';
import { activeRuns, recoverInterruptedRuns } from './services/runs.js';

async function main(): Promise<void> {
  const app = await buildApp();
  const availability = await checkDatabase();
  if (availability.available) {
    const schema = await schemaState();
    if (schema.pending.length > 0) {
      app.log.warn(
        { pending: schema.pending },
        'Database schema has pending migrations. Run npm run db:deploy before using database-backed features.',
      );
    }
    const recovered = await recoverInterruptedRuns();
    if (recovered > 0)
      app.log.warn({ recovered }, 'Marked interrupted verification runs as errored after an unclean shutdown.');
  } else {
    app.log.error(
      { error: availability.error },
      'Database is unreachable. The API will start, but authentication and persistence are unavailable until the database is fixed. Run npm run db:setup.',
    );
  }

  try {
    await app.listen({ host: config.apiHost, port: config.apiPort });
    app.log.info(`ZetHub Proof API listening on http://${config.apiHost}:${config.apiPort} (${config.nodeEnv})`);
    app.log.info(`OpenAPI documentation: http://${config.apiHost}:${config.apiPort}/api/docs`);
  } catch (error) {
    app.log.error({ err: error }, 'Failed to start the API server.');
    process.exitCode = 1;
    await app.close().catch(() => undefined);
    return;
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'Shutting down.');
    for (const [runId, active] of activeRuns) {
      app.log.warn(
        { runId },
        'Aborting active verification run because the server is shutting down. The run will be recorded as interrupted.',
      );
      active.controller.abort();
    }
    const timer = setTimeout(() => {
      app.log.error('Graceful shutdown timed out; exiting.');
      process.exit(1);
    }, 15_000);
    timer.unref();
    try {
      await app.close();
      await disconnectDatabase();
    } catch (error) {
      app.log.error({ err: error }, 'Error during shutdown.');
    } finally {
      clearTimeout(timer);
      process.exit(0);
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'Unhandled promise rejection');
  });
  process.on('uncaughtException', (error) => {
    app.log.error({ err: error }, 'Uncaught exception; shutting down.');
    void shutdown('uncaughtException');
  });
}

void main();
