-- LEKER - Agregar zona y vendedor asignado a clientes
-- Ejecutar en Supabase SQL Editor

-- Agregar columna zone a clients
ALTER TABLE clients
ADD COLUMN IF NOT EXISTS zone VARCHAR(100);

-- Agregar columna assigned_user_id para vincular con vendedor
ALTER TABLE clients
ADD COLUMN IF NOT EXISTS assigned_user_id UUID REFERENCES users(id);

-- Crear indice para busquedas por zona
CREATE INDEX IF NOT EXISTS idx_clients_zone ON clients(zone);

-- Crear indice para busquedas por vendedor asignado
CREATE INDEX IF NOT EXISTS idx_clients_assigned_user ON clients(assigned_user_id);

-- Actualizar zonas basadas en comuna (temporal hasta asignar manualmente)
UPDATE clients SET zone = commune WHERE zone IS NULL;

-- Ver clientes por zona
-- SELECT zone, COUNT(*) as total FROM clients GROUP BY zone ORDER BY total DESC;
