-- LEKER - Agregar campo assigned_user_id a clientes
-- Ejecutar en Supabase SQL Editor

-- Agregar columna para asignar ejecutivo a cliente
ALTER TABLE clients
ADD COLUMN IF NOT EXISTS assigned_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- Agregar columna zone si no existe (para filtrar por zona)
ALTER TABLE clients
ADD COLUMN IF NOT EXISTS zone TEXT;

-- Crear índice para búsquedas por ejecutivo asignado
CREATE INDEX IF NOT EXISTS idx_clients_assigned_user
ON clients(assigned_user_id)
WHERE assigned_user_id IS NOT NULL;

-- Comentarios
COMMENT ON COLUMN clients.assigned_user_id IS 'ID del ejecutivo/vendedor asignado a este cliente';
COMMENT ON COLUMN clients.zone IS 'Zona geográfica del cliente para agrupación';
