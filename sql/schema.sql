/* MASTER SCHEMA: SISTEMA DE GESTIÓN INTEGRAL (LEKER)
   Módulo 1: Gestión de Rutas y Flota
   Módulo 2: Inteligencia de Mercado (Preparado para n8n)
*/

-- =============================================
-- MÓDULO 1: CORE (Usuarios, Clientes, Rutas)
-- =============================================

-- 1. Usuarios (Vendedores y Admin)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT CHECK (role IN ('admin', 'executive')) DEFAULT 'executive',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Flota (Para cálculo de costos de ruta)
CREATE TABLE IF NOT EXISTS vehicles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    license_plate TEXT UNIQUE NOT NULL,
    model TEXT NOT NULL,
    fuel_efficiency_kml NUMERIC DEFAULT 12,
    status TEXT CHECK (status IN ('active', 'maintenance', 'inactive')) DEFAULT 'active',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Clientes (Segmentados A, B, C)
CREATE TABLE IF NOT EXISTS clients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_id TEXT UNIQUE,
    name TEXT NOT NULL,
    fantasy_name TEXT,
    address TEXT,
    commune TEXT,
    segment TEXT CHECK (segment IN ('A', 'B', 'C')) DEFAULT 'C',
    priority TEXT CHECK (priority IN ('FOCO', 'Normal')) DEFAULT 'Normal',
    lat NUMERIC,
    lng NUMERIC,
    last_visit_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Rutas Diarias (Cabecera)
CREATE TABLE IF NOT EXISTS daily_routes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    vehicle_id UUID REFERENCES vehicles(id) ON DELETE SET NULL,
    date DATE DEFAULT CURRENT_DATE,
    start_km NUMERIC,
    end_km NUMERIC,
    total_cost_clp NUMERIC,
    status TEXT CHECK (status IN ('active', 'completed', 'cancelled')) DEFAULT 'active',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Visitas (Detalle con Audio)
CREATE TABLE IF NOT EXISTS visits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    route_id UUID REFERENCES daily_routes(id) ON DELETE CASCADE,
    client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
    check_in TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    check_out TIMESTAMP WITH TIME ZONE,
    outcome TEXT CHECK (outcome IN ('pending', 'contacted', 'no_contact', 'sale', 'no_stock', 'not_interested')) DEFAULT 'pending',
    audio_url TEXT,
    ai_summary TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =============================================
-- MÓDULO 2: INTELIGENCIA DE MERCADO (Base para n8n)
-- =============================================

-- 6. Productos Leker (Tu Catálogo)
CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sku TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    base_cost NUMERIC,
    list_price NUMERIC,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 7. Competidores (La lista de quiénes monitoreas)
CREATE TABLE IF NOT EXISTS competitors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    website_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 8. Monitor de Precios (Aquí inyectará datos n8n)
CREATE TABLE IF NOT EXISTS price_intelligence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    competitor_id UUID REFERENCES competitors(id) ON DELETE CASCADE,
    detected_price NUMERIC NOT NULL,
    captured_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    source TEXT CHECK (source IN ('n8n_scraper', 'sales_rep_report', 'manual')) DEFAULT 'manual',
    evidence_url TEXT
);

-- =============================================
-- ÍNDICES PARA OPTIMIZACIÓN
-- =============================================

CREATE INDEX IF NOT EXISTS idx_daily_routes_user_date ON daily_routes(user_id, date);
CREATE INDEX IF NOT EXISTS idx_daily_routes_status ON daily_routes(status);
CREATE INDEX IF NOT EXISTS idx_visits_route ON visits(route_id);
CREATE INDEX IF NOT EXISTS idx_visits_client ON visits(client_id);
CREATE INDEX IF NOT EXISTS idx_price_intelligence_product ON price_intelligence(product_id);
CREATE INDEX IF NOT EXISTS idx_price_intelligence_competitor ON price_intelligence(competitor_id);
CREATE INDEX IF NOT EXISTS idx_price_intelligence_captured ON price_intelligence(captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_clients_segment ON clients(segment);
CREATE INDEX IF NOT EXISTS idx_clients_commune ON clients(commune);

-- =============================================
-- DATOS INICIALES DE EJEMPLO
-- =============================================

-- Usuario inicial
INSERT INTO users (email, full_name, role)
VALUES ('d.taricco@leker.cl', 'D. Taricco', 'executive')
ON CONFLICT (email) DO NOTHING;

INSERT INTO users (email, full_name, role)
VALUES ('admin@leker.cl', 'Administrador', 'admin')
ON CONFLICT (email) DO NOTHING;

-- Vehículos iniciales
INSERT INTO vehicles (license_plate, model, fuel_efficiency_kml, status)
VALUES ('HJKL-45', 'Fiat Fiorino 2024', 12.5, 'active')
ON CONFLICT (license_plate) DO NOTHING;

INSERT INTO vehicles (license_plate, model, fuel_efficiency_kml, status)
VALUES ('PQRS-78', 'Renault Kangoo 2023', 11.8, 'active')
ON CONFLICT (license_plate) DO NOTHING;

-- Competidores
INSERT INTO competitors (name, website_url) VALUES ('Sodimac', 'https://sodimac.cl') ON CONFLICT (name) DO NOTHING;
INSERT INTO competitors (name, website_url) VALUES ('Easy', 'https://easy.cl') ON CONFLICT (name) DO NOTHING;
INSERT INTO competitors (name, website_url) VALUES ('Construmart', 'https://construmart.cl') ON CONFLICT (name) DO NOTHING;
INSERT INTO competitors (name, website_url) VALUES ('MTS Chile', 'https://mts.cl') ON CONFLICT (name) DO NOTHING;

-- Productos de ejemplo
INSERT INTO products (sku, name, base_cost, list_price)
VALUES ('LK-TALADRO-001', 'Taladro Percutor 750W', 25000, 45990)
ON CONFLICT (sku) DO NOTHING;

INSERT INTO products (sku, name, base_cost, list_price)
VALUES ('LK-SIERRA-002', 'Sierra Circular 1200W', 35000, 62990)
ON CONFLICT (sku) DO NOTHING;

INSERT INTO products (sku, name, base_cost, list_price)
VALUES ('LK-LIJADORA-003', 'Lijadora Orbital 300W', 15000, 28990)
ON CONFLICT (sku) DO NOTHING;
