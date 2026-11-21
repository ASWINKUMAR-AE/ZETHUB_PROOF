-- CreateTable
CREATE TABLE `users` (
    `id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(190) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `passwordHash` VARCHAR(255) NOT NULL,
    `role` ENUM('OWNER', 'ADMIN', 'VIEWER') NOT NULL DEFAULT 'OWNER',
    `disabled` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `lastLoginAt` DATETIME(3) NULL,

    UNIQUE INDEX `users_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sessions` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(64) NOT NULL,
    `csrfToken` VARCHAR(64) NOT NULL,
    `ip` VARCHAR(64) NULL,
    `userAgent` VARCHAR(255) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `revokedAt` DATETIME(3) NULL,

    UNIQUE INDEX `sessions_tokenHash_key`(`tokenHash`),
    INDEX `sessions_userId_expiresAt_idx`(`userId`, `expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `projects` (
    `id` VARCHAR(191) NOT NULL,
    `ownerId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `description` TEXT NULL,
    `sourceType` ENUM('LOCAL', 'GIT', 'URL') NOT NULL DEFAULT 'LOCAL',
    `rootPath` VARCHAR(1024) NULL,
    `repoUrl` VARCHAR(1024) NULL,
    `websiteUrl` VARCHAR(1024) NULL,
    `defaultBranch` VARCHAR(190) NULL,
    `pinned` BOOLEAN NOT NULL DEFAULT false,
    `archived` BOOLEAN NOT NULL DEFAULT false,
    `health` ENUM('UNKNOWN', 'HEALTHY', 'DEGRADED', 'FAILING') NOT NULL DEFAULT 'UNKNOWN',
    `detectionJson` JSON NULL,
    `lastVerifiedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `projects_ownerId_archived_idx`(`ownerId`, `archived`),
    UNIQUE INDEX `projects_ownerId_name_key`(`ownerId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `project_environments` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `kind` ENUM('LOCAL', 'TEST', 'STAGING', 'PRODUCTION') NOT NULL DEFAULT 'LOCAL',
    `baseUrl` VARCHAR(1024) NULL,
    `variables` JSON NULL,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `project_environments_projectId_name_key`(`projectId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `project_adapters` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `adapterId` VARCHAR(80) NOT NULL,
    `version` VARCHAR(40) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `configJson` JSON NULL,
    `detectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `project_adapters_projectId_adapterId_key`(`projectId`, `adapterId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `test_plans` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `strategy` ENUM('FULL', 'CHANGED', 'SELECTED') NOT NULL DEFAULT 'FULL',
    `coverageConfidence` VARCHAR(20) NOT NULL,
    `planJson` JSON NOT NULL,
    `notesJson` JSON NULL,
    `unverifiedJson` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `test_plans_projectId_createdAt_idx`(`projectId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `test_cases` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `key` VARCHAR(190) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `kind` VARCHAR(40) NOT NULL,
    `adapterId` VARCHAR(80) NOT NULL,
    `source` ENUM('DETECTED', 'USER', 'AI') NOT NULL DEFAULT 'DETECTED',
    `reason` TEXT NULL,
    `configJson` JSON NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `requiresApproval` BOOLEAN NOT NULL DEFAULT true,
    `mappedFiles` JSON NULL,
    `tags` JSON NULL,
    `priority` INTEGER NOT NULL DEFAULT 50,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `test_cases_projectId_kind_idx`(`projectId`, `kind`),
    UNIQUE INDEX `test_cases_projectId_key_key`(`projectId`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `test_runs` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `planId` VARCHAR(191) NULL,
    `userId` VARCHAR(191) NULL,
    `trigger` ENUM('MANUAL', 'CLI', 'CI', 'REPAIR_RETEST', 'SCHEDULED') NOT NULL DEFAULT 'MANUAL',
    `status` ENUM('QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'BLOCKED', 'CANCELLED', 'TIMEOUT', 'ERROR', 'UNVERIFIED') NOT NULL DEFAULT 'QUEUED',
    `strategy` ENUM('FULL', 'CHANGED', 'SELECTED') NOT NULL DEFAULT 'FULL',
    `gitCommit` VARCHAR(64) NULL,
    `gitBranch` VARCHAR(190) NULL,
    `environmentJson` JSON NOT NULL,
    `totalCount` INTEGER NOT NULL DEFAULT 0,
    `passedCount` INTEGER NOT NULL DEFAULT 0,
    `failedCount` INTEGER NOT NULL DEFAULT 0,
    `blockedCount` INTEGER NOT NULL DEFAULT 0,
    `unverifiedCount` INTEGER NOT NULL DEFAULT 0,
    `skippedCount` INTEGER NOT NULL DEFAULT 0,
    `durationMs` INTEGER NOT NULL DEFAULT 0,
    `verifiedScope` TEXT NULL,
    `limitationsJson` JSON NULL,
    `errorMessage` TEXT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `test_runs_projectId_startedAt_idx`(`projectId`, `startedAt`),
    INDEX `test_runs_status_startedAt_idx`(`status`, `startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `test_results` (
    `id` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NOT NULL,
    `key` VARCHAR(190) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `kind` VARCHAR(40) NOT NULL,
    `adapterId` VARCHAR(80) NOT NULL,
    `status` ENUM('PASSED', 'FAILED', 'BLOCKED', 'CANCELLED', 'TIMEOUT', 'ERROR', 'SKIPPED', 'UNVERIFIED') NOT NULL,
    `durationMs` INTEGER NOT NULL DEFAULT 0,
    `exitCode` INTEGER NULL,
    `commandDisplay` TEXT NULL,
    `stdout` MEDIUMTEXT NULL,
    `stderr` MEDIUMTEXT NULL,
    `classification` VARCHAR(80) NULL,
    `message` TEXT NULL,
    `metadataJson` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `test_results_runId_status_idx`(`runId`, `status`),
    UNIQUE INDEX `test_results_runId_key_key`(`runId`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `test_assertions` (
    `id` VARCHAR(191) NOT NULL,
    `resultId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(500) NOT NULL,
    `status` ENUM('PASSED', 'FAILED', 'BLOCKED', 'CANCELLED', 'TIMEOUT', 'ERROR', 'SKIPPED', 'UNVERIFIED') NOT NULL,
    `expected` TEXT NULL,
    `actual` TEXT NULL,
    `message` TEXT NULL,
    `durationMs` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `test_assertions_resultId_status_idx`(`resultId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `evidence_artifacts` (
    `id` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NOT NULL,
    `resultId` VARCHAR(191) NULL,
    `kind` ENUM('STDOUT', 'STDERR', 'SCREENSHOT', 'TRACE', 'VIDEO', 'JSON', 'HTML', 'JUNIT', 'DIFF', 'LOG', 'REPORT', 'CAPSULE') NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `relativePath` VARCHAR(1024) NOT NULL,
    `mimeType` VARCHAR(120) NOT NULL,
    `sizeBytes` BIGINT NOT NULL DEFAULT 0,
    `sha256` VARCHAR(64) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `evidence_artifacts_runId_idx`(`runId`),
    INDEX `evidence_artifacts_sha256_idx`(`sha256`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `verification_reports` (
    `id` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NOT NULL,
    `format` ENUM('HTML', 'JSON', 'JUNIT') NOT NULL,
    `relativePath` VARCHAR(1024) NOT NULL,
    `sha256` VARCHAR(64) NOT NULL,
    `manifestJson` JSON NULL,
    `generatedBy` VARCHAR(120) NOT NULL,
    `generatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `verification_reports_runId_format_key`(`runId`, `format`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `failure_capsules` (
    `id` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NOT NULL,
    `resultId` VARCHAR(191) NULL,
    `testKey` VARCHAR(190) NOT NULL,
    `relativePath` VARCHAR(1024) NOT NULL,
    `sha256` VARCHAR(64) NOT NULL,
    `formatVersion` INTEGER NOT NULL DEFAULT 1,
    `redactions` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `failure_capsules_resultId_key`(`resultId`),
    INDEX `failure_capsules_runId_idx`(`runId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `repair_proposals` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NULL,
    `testKey` VARCHAR(190) NOT NULL,
    `classification` VARCHAR(80) NOT NULL,
    `causesJson` JSON NULL,
    `diff` LONGTEXT NOT NULL,
    `filesJson` JSON NULL,
    `status` ENUM('PROPOSED', 'APPROVED', 'APPLIED', 'REJECTED', 'VERIFIED', 'FAILED') NOT NULL DEFAULT 'PROPOSED',
    `retestRunId` VARCHAR(191) NULL,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `appliedAt` DATETIME(3) NULL,
    `verifiedAt` DATETIME(3) NULL,

    INDEX `repair_proposals_projectId_status_idx`(`projectId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `integrations` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NULL,
    `type` ENUM('GIT', 'GITHUB', 'BROWSER', 'AI', 'DATABASE', 'API', 'CI') NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `configJson` JSON NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `status` VARCHAR(40) NULL,
    `lastCheckedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `integrations_projectId_type_name_key`(`projectId`, `type`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `integration_credentials_metadata` (
    `id` VARCHAR(191) NOT NULL,
    `integrationId` VARCHAR(191) NOT NULL,
    `keyName` VARCHAR(80) NOT NULL,
    `storage` ENUM('WINDOWS_DPAPI', 'LIBCREDENTIAL', 'ENCRYPTED_FILE', 'ENVIRONMENT') NOT NULL DEFAULT 'ENCRYPTED_FILE',
    `fingerprint` VARCHAR(64) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `rotatedAt` DATETIME(3) NULL,

    UNIQUE INDEX `integration_credentials_metadata_integrationId_keyName_key`(`integrationId`, `keyName`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notifications` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `type` VARCHAR(60) NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `body` TEXT NULL,
    `readAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `notifications_userId_readAt_idx`(`userId`, `readAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_logs` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NULL,
    `action` ENUM('LOGIN', 'LOGOUT', 'PROJECT_CREATE', 'PROJECT_UPDATE', 'PROJECT_DELETE', 'SCAN', 'PLAN_CREATE', 'RUN_START', 'RUN_CANCEL', 'RUN_COMPLETE', 'REPORT_GENERATE', 'CAPSULE_EXPORT', 'CAPSULE_IMPORT', 'REPAIR_PROPOSE', 'REPAIR_APPLY', 'DB_SETUP', 'DB_MIGRATE', 'DB_BACKUP', 'DB_RESTORE', 'INTEGRATION_UPDATE', 'SETTINGS_UPDATE', 'SYNC', 'SECURITY_DENIED') NOT NULL,
    `entityType` VARCHAR(80) NOT NULL,
    `entityId` VARCHAR(80) NULL,
    `metadata` JSON NULL,
    `ip` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_logs_createdAt_idx`(`createdAt`),
    INDEX `audit_logs_userId_action_idx`(`userId`, `action`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sync_queue` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `clientId` VARCHAR(120) NOT NULL,
    `type` VARCHAR(60) NOT NULL,
    `payloadJson` JSON NOT NULL,
    `status` ENUM('PENDING', 'SYNCED', 'FAILED', 'CONFLICT') NOT NULL DEFAULT 'PENDING',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `lastError` TEXT NULL,
    `idempotencyKey` VARCHAR(190) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `syncedAt` DATETIME(3) NULL,

    UNIQUE INDEX `sync_queue_idempotencyKey_key`(`idempotencyKey`),
    INDEX `sync_queue_userId_status_idx`(`userId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_settings` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `settingsJson` JSON NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `user_settings_userId_key`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `db_backups` (
    `id` VARCHAR(191) NOT NULL,
    `fileName` VARCHAR(255) NOT NULL,
    `path` VARCHAR(1024) NOT NULL,
    `sizeBytes` BIGINT NOT NULL,
    `sha256` VARCHAR(64) NOT NULL,
    `verified` BOOLEAN NOT NULL DEFAULT false,
    `message` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `db_backups_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `db_health_checks` (
    `id` VARCHAR(191) NOT NULL,
    `readOk` BOOLEAN NOT NULL,
    `writeOk` BOOLEAN NOT NULL,
    `latencyMs` INTEGER NOT NULL,
    `checkedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `db_health_checks_checkedAt_idx`(`checkedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `deployment_locks` (
    `name` VARCHAR(80) NOT NULL,
    `owner` VARCHAR(120) NOT NULL,
    `lockedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`name`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `projects` ADD CONSTRAINT `projects_ownerId_fkey` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `project_environments` ADD CONSTRAINT `project_environments_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `project_adapters` ADD CONSTRAINT `project_adapters_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `test_plans` ADD CONSTRAINT `test_plans_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `test_cases` ADD CONSTRAINT `test_cases_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `test_runs` ADD CONSTRAINT `test_runs_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `test_runs` ADD CONSTRAINT `test_runs_planId_fkey` FOREIGN KEY (`planId`) REFERENCES `test_plans`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `test_runs` ADD CONSTRAINT `test_runs_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `test_results` ADD CONSTRAINT `test_results_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `test_runs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `test_assertions` ADD CONSTRAINT `test_assertions_resultId_fkey` FOREIGN KEY (`resultId`) REFERENCES `test_results`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `evidence_artifacts` ADD CONSTRAINT `evidence_artifacts_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `test_runs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `evidence_artifacts` ADD CONSTRAINT `evidence_artifacts_resultId_fkey` FOREIGN KEY (`resultId`) REFERENCES `test_results`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `verification_reports` ADD CONSTRAINT `verification_reports_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `test_runs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `failure_capsules` ADD CONSTRAINT `failure_capsules_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `test_runs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `failure_capsules` ADD CONSTRAINT `failure_capsules_resultId_fkey` FOREIGN KEY (`resultId`) REFERENCES `test_results`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `repair_proposals` ADD CONSTRAINT `repair_proposals_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `repair_proposals` ADD CONSTRAINT `repair_proposals_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `test_runs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `repair_proposals` ADD CONSTRAINT `repair_proposals_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `integrations` ADD CONSTRAINT `integrations_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `integration_credentials_metadata` ADD CONSTRAINT `integration_credentials_metadata_integrationId_fkey` FOREIGN KEY (`integrationId`) REFERENCES `integrations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_settings` ADD CONSTRAINT `user_settings_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

