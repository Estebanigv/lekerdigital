-- Agregar dirección de casa del vendedor para punto de inicio/fin de rutas
ALTER TABLE users ADD COLUMN IF NOT EXISTS home_address TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS home_lat NUMERIC(10,8);
ALTER TABLE users ADD COLUMN IF NOT EXISTS home_lng NUMERIC(11,8);
