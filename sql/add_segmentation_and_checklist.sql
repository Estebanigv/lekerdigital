-- =============================================
-- MIGRACIÓN: Segmentación, Checklist, Rutas Planificadas, Stats Vendedor
-- Ejecutar en Supabase SQL Editor
-- =============================================

-- 1. Extender tabla clients con campos de segmentación y contacto
ALTER TABLE clients ADD COLUMN IF NOT EXISTS segmentation TEXT DEFAULT 'N';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS competitor_provider1 TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS competitor_provider2 TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS is_competitor_client BOOLEAN DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS owner_name TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS buyer_name TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS phone2 TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS observations TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS visit_frequency_days INTEGER DEFAULT 30;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS consecutive_no_sale INTEGER DEFAULT 0;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS last_sale_date TIMESTAMP;

-- Índices para segmentación
CREATE INDEX IF NOT EXISTS idx_clients_segmentation ON clients(segmentation);
CREATE INDEX IF NOT EXISTS idx_clients_is_competitor ON clients(is_competitor_client);

-- 2. Extender tabla visits con datos de checklist
ALTER TABLE visits ADD COLUMN IF NOT EXISTS checklist_data JSONB;

-- 3. Nueva tabla: scheduled_routes (rutas planificadas)
CREATE TABLE IF NOT EXISTS scheduled_routes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scheduled_date DATE NOT NULL,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  priority INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'rescheduled', 'skipped')),
  original_date DATE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_routes_user_date ON scheduled_routes(user_id, scheduled_date);
CREATE INDEX IF NOT EXISTS idx_scheduled_routes_status ON scheduled_routes(status);

-- 4. Nueva tabla: vendor_monthly_stats (estadísticas mensuales por vendedor)
CREATE TABLE IF NOT EXISTS vendor_monthly_stats (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  total_visits INTEGER DEFAULT 0,
  total_sales INTEGER DEFAULT 0,
  total_clients_with_sale INTEGER DEFAULT 0,
  total_revenue NUMERIC DEFAULT 0,
  weekly_data JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, month)
);

CREATE INDEX IF NOT EXISTS idx_vendor_monthly_stats_month ON vendor_monthly_stats(month);
