-- =============================================
-- ROUTE PLANNER V2 - MIGRATION
-- Tables: route_modifications, route_alerts
-- Columns: estimated_arrival, estimated_duration, modified_by, notes on scheduled_routes
-- =============================================

-- Tabla de modificaciones de ruta (cuando ejecutivo cambia algo)
CREATE TABLE IF NOT EXISTS route_modifications (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  scheduled_route_id UUID REFERENCES scheduled_routes(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  modification_type TEXT CHECK (modification_type IN ('skip', 'reorder', 'add', 'remove', 'reschedule')),
  reason TEXT,
  old_value JSONB,
  new_value JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Tabla de alertas para admin
CREATE TABLE IF NOT EXISTS route_alerts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  alert_type TEXT CHECK (alert_type IN ('route_modified', 'route_rescheduled', 'visit_skipped')),
  user_id UUID NOT NULL REFERENCES users(id),
  admin_id UUID REFERENCES users(id),
  message TEXT NOT NULL,
  metadata JSONB,
  read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_route_alerts_admin ON route_alerts(admin_id, read);
CREATE INDEX IF NOT EXISTS idx_route_modifications_route ON route_modifications(scheduled_route_id);

-- Agregar campos a scheduled_routes
ALTER TABLE scheduled_routes ADD COLUMN IF NOT EXISTS estimated_arrival TIME;
ALTER TABLE scheduled_routes ADD COLUMN IF NOT EXISTS estimated_duration INTEGER DEFAULT 30;
ALTER TABLE scheduled_routes ADD COLUMN IF NOT EXISTS modified_by UUID REFERENCES users(id);
ALTER TABLE scheduled_routes ADD COLUMN IF NOT EXISTS notes TEXT;
