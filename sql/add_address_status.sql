-- Migration: Add address validation status to clients
-- Run in Supabase SQL Editor

-- Status for address validation
ALTER TABLE clients ADD COLUMN IF NOT EXISTS address_status TEXT DEFAULT 'auto'
  CHECK (address_status IN ('auto', 'confirmed', 'pending'));

-- When was the address confirmed in the field
ALTER TABLE clients ADD COLUMN IF NOT EXISTS address_confirmed_at TIMESTAMP WITH TIME ZONE;

-- Who confirmed the address (vendor ID)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS address_confirmed_by UUID REFERENCES users(id);

-- Set initial statuses based on existing GPS data
UPDATE clients SET address_status = 'pending' WHERE (lat IS NULL OR lng IS NULL);
UPDATE clients SET address_status = 'auto' WHERE lat IS NOT NULL AND lng IS NOT NULL AND address_status IS NULL;
