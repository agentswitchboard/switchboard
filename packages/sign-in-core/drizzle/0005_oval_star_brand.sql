ALTER TABLE `deviceCode` RENAME COLUMN "machineInstallationId" TO "machineId";--> statement-breakpoint
ALTER TABLE `deviceCode` ADD `decisionClaim` text;--> statement-breakpoint
ALTER TABLE `deviceCode` DROP COLUMN `machinePeerId`;