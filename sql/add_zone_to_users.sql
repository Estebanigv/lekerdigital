-- Agregar campos de zona a tabla users
ALTER TABLE users ADD COLUMN IF NOT EXISTS zone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS zone_leader BOOLEAN DEFAULT false;

-- Actualizar constraint de role para incluir 'zonal'
-- (Solo si existe constraint, sino ignorar)
DO $$
BEGIN
  -- Drop existing constraint if it exists
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

  -- Add new constraint with 'zonal' role
  ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('executive', 'admin', 'supervisor', 'zonal'));
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Constraint update skipped: %', SQLERRM;
END $$;

-- Configurar zonales iniciales
UPDATE users SET zone = 'Norte', zone_leader = true WHERE full_name ILIKE '%M.GARCIA%' OR full_name ILIKE '%GARCIA%M%';
UPDATE users SET zone = 'Centro Sur', zone_leader = true WHERE full_name ILIKE '%M.ARROYO%' OR full_name ILIKE '%ARROYO%M%';
UPDATE users SET zone = 'Centro', zone_leader = true WHERE full_name ILIKE '%D.ALMERIDA%' OR full_name ILIKE '%ALMERIDA%D%';
UPDATE users SET zone = 'Sur', zone_leader = true WHERE full_name ILIKE '%A.REHBEIN%' OR full_name ILIKE '%REHBEIN%A%';
