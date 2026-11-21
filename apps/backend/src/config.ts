import path from 'node:path';
import { loadEnv, loadConfig, findRoot, requireLocalBinding, type AppConfig } from '@zethub/verification-core';

loadEnv(findRoot());
const config: AppConfig = loadConfig();
requireLocalBinding(config.apiHost);

if (!process.env.DATABASE_URL) process.env.DATABASE_URL = config.db.databaseUrl;

export const APP_VERSION = '0.1.0';
export { config };
export const paths = {
  root: config.rootDir,
  artifacts: config.artifactsDir,
  backups: config.backupsDir,
  data: path.join(config.rootDir, 'data'),
  logs: path.join(config.rootDir, 'data', 'logs'),
};
