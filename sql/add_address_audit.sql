-- Auditoría de cambios de dirección en clientes
-- Ejecutar en Supabase SQL Editor

-- Timestamp de última modificación de dirección
ALTER TABLE clients ADD COLUMN IF NOT EXISTS address_updated_at TIMESTAMP WITH TIME ZONE;

-- UUID del usuario que modificó la dirección (referencia a users)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS address_updated_by UUID REFERENCES users(id);

-- Índice para consultas de auditoría
CREATE INDEX IF NOT EXISTS idx_clients_address_updated_at ON clients(address_updated_at) WHERE address_updated_at IS NOT NULL;
