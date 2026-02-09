-- Migration: Add authentication fields to users table
-- Run this in the Supabase SQL Editor

-- Add password_hash column
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- Add last_login column
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ;

-- Create index on email for fast login lookups
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
