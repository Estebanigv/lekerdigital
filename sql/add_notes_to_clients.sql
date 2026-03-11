-- Migración: Agregar campo notas a clientes
-- Ejecutar en Supabase Dashboard → SQL Editor
ALTER TABLE clients ADD COLUMN IF NOT EXISTS notes TEXT;
