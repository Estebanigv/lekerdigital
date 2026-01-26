-- LEKER - Agregar geolocalización a visitas
-- Ejecutar en Supabase SQL Editor

-- Agregar columnas de geolocalización al check-in
ALTER TABLE visits
ADD COLUMN IF NOT EXISTS check_in_lat DECIMAL(10, 8),
ADD COLUMN IF NOT EXISTS check_in_lng DECIMAL(11, 8);

-- Agregar columnas de geolocalización al check-out (para futuro uso)
ALTER TABLE visits
ADD COLUMN IF NOT EXISTS check_out_lat DECIMAL(10, 8),
ADD COLUMN IF NOT EXISTS check_out_lng DECIMAL(11, 8);

-- Crear índice para búsquedas geográficas
CREATE INDEX IF NOT EXISTS idx_visits_checkin_location
ON visits(check_in_lat, check_in_lng)
WHERE check_in_lat IS NOT NULL;

-- También asegurarse que la tabla clients tenga lat/lng
ALTER TABLE clients
ADD COLUMN IF NOT EXISTS lat DECIMAL(10, 8),
ADD COLUMN IF NOT EXISTS lng DECIMAL(11, 8);

-- Índice para clientes con ubicación
CREATE INDEX IF NOT EXISTS idx_clients_location
ON clients(lat, lng)
WHERE lat IS NOT NULL;

-- Comentarios
COMMENT ON COLUMN visits.check_in_lat IS 'Latitud GPS al momento del check-in';
COMMENT ON COLUMN visits.check_in_lng IS 'Longitud GPS al momento del check-in';
COMMENT ON COLUMN visits.check_out_lat IS 'Latitud GPS al momento del check-out';
COMMENT ON COLUMN visits.check_out_lng IS 'Longitud GPS al momento del check-out';
