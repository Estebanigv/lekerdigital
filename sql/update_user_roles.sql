-- LEKER - Sistema de Roles Actualizado
-- Ejecutar en Supabase SQL Editor

-- Los roles del sistema son:
-- 'admin'      - Control total del sistema (configuración, usuarios, todo)
-- 'supervisor' - Ejecutivo administrador (ve todo, gestiona ejecutivos, no configura sistema)
-- 'executive'  - Ejecutivo normal (sus rutas, sus clientes asignados)
-- 'viewer'     - Solo lectura (dashboards, metas, marketing asignado)

-- Asegurarse que el campo role acepta los nuevos valores
-- No necesitamos cambiar la estructura, solo documentar los valores válidos

-- Crear tabla de permisos por rol (para referencia)
CREATE TABLE IF NOT EXISTS role_permissions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  role TEXT NOT NULL,
  permission TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(role, permission)
);

-- Limpiar permisos existentes
DELETE FROM role_permissions;

-- Permisos para ADMIN (todo)
INSERT INTO role_permissions (role, permission) VALUES
  ('admin', 'system.configure'),
  ('admin', 'users.manage'),
  ('admin', 'users.create'),
  ('admin', 'users.delete'),
  ('admin', 'roles.assign'),
  ('admin', 'data.import'),
  ('admin', 'data.export'),
  ('admin', 'clients.manage'),
  ('admin', 'clients.assign'),
  ('admin', 'routes.view_all'),
  ('admin', 'routes.manage'),
  ('admin', 'dashboard.view'),
  ('admin', 'reports.view'),
  ('admin', 'marketing.configure'),
  ('admin', 'marketing.view');

-- Permisos para SUPERVISOR (ejecutivo administrador)
INSERT INTO role_permissions (role, permission) VALUES
  ('supervisor', 'users.view'),
  ('supervisor', 'clients.manage'),
  ('supervisor', 'clients.assign'),
  ('supervisor', 'routes.view_all'),
  ('supervisor', 'routes.manage'),
  ('supervisor', 'dashboard.view'),
  ('supervisor', 'reports.view'),
  ('supervisor', 'marketing.view'),
  ('supervisor', 'data.export');

-- Permisos para EXECUTIVE (ejecutivo normal)
INSERT INTO role_permissions (role, permission) VALUES
  ('executive', 'clients.view_assigned'),
  ('executive', 'routes.view_own'),
  ('executive', 'routes.create_own'),
  ('executive', 'visits.create'),
  ('executive', 'dashboard.view_own');

-- Permisos para VIEWER (solo lectura)
INSERT INTO role_permissions (role, permission) VALUES
  ('viewer', 'dashboard.view'),
  ('viewer', 'reports.view'),
  ('viewer', 'marketing.view'),
  ('viewer', 'clients.view_assigned');

-- Comentarios
COMMENT ON TABLE role_permissions IS 'Permisos asignados a cada rol del sistema';
COMMENT ON COLUMN role_permissions.role IS 'admin, supervisor, executive, viewer';
COMMENT ON COLUMN role_permissions.permission IS 'Permiso específico del sistema';
