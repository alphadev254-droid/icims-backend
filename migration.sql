-- Migration: Update schema for package-user architecture
-- Run this after updating schema.prisma

-- Add new columns to users table
ALTER TABLE users ADD COLUMN packageId VARCHAR(191) NULL;
ALTER TABLE users ADD COLUMN nationalAdminId VARCHAR(191) NULL;

-- Add new columns to churches table  
ALTER TABLE churches ADD COLUMN nationalAdminId VARCHAR(191) NULL;

-- Add new columns to packages table
ALTER TABLE packages ADD COLUMN maxChurches INT NOT NULL DEFAULT 1;

-- Remove package column from churches (no longer needed)
ALTER TABLE churches DROP COLUMN package;

-- Add foreign key constraints
ALTER TABLE users ADD CONSTRAINT users_packageId_fkey 
  FOREIGN KEY (packageId) REFERENCES packages(id) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE churches ADD CONSTRAINT churches_nationalAdminId_fkey 
  FOREIGN KEY (nationalAdminId) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE;

-- Update existing packages with maxChurches values
UPDATE packages SET maxChurches = 1 WHERE name = 'basic';
UPDATE packages SET maxChurches = 5 WHERE name = 'standard';  
UPDATE packages SET maxChurches = 999 WHERE name = 'premium';

-- Note: You may need to manually assign packageId to existing national admin users
-- and set nationalAdminId for existing churches based on your business logic