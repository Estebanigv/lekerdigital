-- LEKER - Tabla de Comparativo de Competencia
-- Recibe datos del workflow n8n "LEKER v32 - STOCKS FIX"
-- Ejecutar en Supabase SQL Editor

-- Tabla principal de comparativo
CREATE TABLE IF NOT EXISTS competitor_comparison (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,

  -- Información del scraping
  scraped_at TIMESTAMPTZ DEFAULT NOW(),
  fecha TEXT,
  hora TEXT,
  fuente TEXT NOT NULL,  -- LEKER, SODIMAC, EASY, etc.

  -- Datos del producto
  sku TEXT,
  nombre TEXT NOT NULL,
  tipo TEXT,  -- Alveolar, Sólido, Corrugado, etc.
  espesor TEXT,  -- 4mm, 6mm, 8mm, etc.

  -- Precio
  precio_neto INTEGER,
  precio_anterior INTEGER,

  -- Metadata
  url TEXT,
  stock_status TEXT,  -- in_stock, out_of_stock, unknown

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Índices para búsquedas rápidas
CREATE INDEX IF NOT EXISTS idx_comparison_fuente ON competitor_comparison(fuente);
CREATE INDEX IF NOT EXISTS idx_comparison_scraped ON competitor_comparison(scraped_at DESC);
CREATE INDEX IF NOT EXISTS idx_comparison_tipo ON competitor_comparison(tipo);
CREATE INDEX IF NOT EXISTS idx_comparison_nombre ON competitor_comparison(nombre);

-- Tabla de resumen semanal (para reportes)
CREATE TABLE IF NOT EXISTS competitor_weekly_summary (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,

  semana DATE NOT NULL,  -- Fecha del lunes de la semana
  fuente TEXT NOT NULL,

  -- Estadísticas
  total_productos INTEGER DEFAULT 0,
  precio_promedio INTEGER DEFAULT 0,
  precio_min INTEGER DEFAULT 0,
  precio_max INTEGER DEFAULT 0,

  -- Comparación con semana anterior
  variacion_precio DECIMAL(5,2),  -- Porcentaje de variación
  productos_nuevos INTEGER DEFAULT 0,
  productos_eliminados INTEGER DEFAULT 0,

  created_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(semana, fuente)
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_weekly_semana ON competitor_weekly_summary(semana DESC);
CREATE INDEX IF NOT EXISTS idx_weekly_fuente ON competitor_weekly_summary(fuente);

-- Vista para comparativo actual (último scraping por fuente)
CREATE OR REPLACE VIEW v_latest_comparison AS
SELECT DISTINCT ON (fuente, nombre)
  id, fuente, nombre, tipo, espesor, precio_neto, url, scraped_at
FROM competitor_comparison
ORDER BY fuente, nombre, scraped_at DESC;

-- Vista para análisis de precios por tipo de producto
CREATE OR REPLACE VIEW v_price_by_type AS
SELECT
  tipo,
  fuente,
  COUNT(*) as total_productos,
  ROUND(AVG(precio_neto)) as precio_promedio,
  MIN(precio_neto) as precio_min,
  MAX(precio_neto) as precio_max
FROM competitor_comparison
WHERE scraped_at > NOW() - INTERVAL '7 days'
  AND precio_neto > 0
GROUP BY tipo, fuente
ORDER BY tipo, fuente;

-- Comentarios
COMMENT ON TABLE competitor_comparison IS 'Datos de scraping de competencia desde n8n workflow LEKER v32';
COMMENT ON TABLE competitor_weekly_summary IS 'Resumen semanal para reportes de comparativo';
COMMENT ON VIEW v_latest_comparison IS 'Último precio registrado por fuente y producto';
COMMENT ON VIEW v_price_by_type IS 'Análisis de precios por tipo de producto y fuente';
