// Datos de prueba para modo demo - Ruta VI O'Higgins

const mockUsers = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    email: 'd.taricco@leker.cl',
    full_name: 'D. Taricco',
    role: 'executive',
    created_at: '2024-01-15T10:00:00Z'
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    email: 'supervisor@leker.cl',
    full_name: 'Supervisor Zona VI',
    role: 'admin',
    created_at: '2024-01-01T08:00:00Z'
  }
];

const mockVehicles = [
  {
    id: 'aaaa1111-1111-1111-1111-111111111111',
    license_plate: 'HJKL-45',
    model: 'Fiat Fiorino 2024',
    fuel_efficiency_kml: 12.5,
    status: 'active'
  },
  {
    id: 'bbbb2222-2222-2222-2222-222222222222',
    license_plate: 'PQRS-78',
    model: 'Renault Kangoo 2023',
    fuel_efficiency_kml: 11.8,
    status: 'active'
  }
];

// Coordenadas de comunas de la Región de O'Higgins
const comunaCoords = {
  'Rengo': [-34.4028, -70.8622],
  'Rancagua': [-34.1708, -70.7444],
  'Lolol': [-34.7281, -71.6442],
  'Doihue': [-34.2333, -70.8833],
  'Coltauco': [-34.2667, -71.1000],
  'Graneros': [-34.0667, -70.7333],
  'Codegua': [-34.0333, -70.6667],
  'San Fernando': [-34.5839, -70.9894],
  'Santa Cruz': [-34.6392, -71.3647],
  'Chimbarongo': [-34.7167, -71.0333],
  'Las Cabras': [-34.2833, -71.3000],
  'Paredones': [-34.6500, -71.9000],
  'Litueche': [-34.1167, -71.7167],
  'La Estrella': [-34.2000, -71.6667],
  'Marchihue': [-34.3833, -71.6167],
  'Nancagua': [-34.6667, -71.1833],
  'Navidad': [-33.9500, -71.8333],
  'Palmilla': [-34.6000, -71.3500],
  'San Vicente': [-34.4333, -71.0833],
  'Pichilemu': [-34.3833, -72.0000],
  'Placilla': [-34.6167, -71.0833],
  'Chepica': [-34.7333, -71.2667],
  'Malloa': [-34.4500, -70.9500],
  'Machali': [-34.1833, -70.6500],
  'Requinoa': [-34.2833, -70.8167],
  'Peumo': [-34.3833, -71.1667],
  'Olivar': [-34.2167, -70.8167],
  'Pichidegua': [-34.3500, -71.2833],
  'Peralillo': [-34.4833, -71.4833],
  'Mostazal': [-33.9833, -70.7000],
  'Rosario': [-34.3000, -71.2167]
};

// Clientes reales de la Ruta VI
const mockClients = [
  // SEMANA 1 - LUNES - Rengo
  {
    id: 'c0001',
    external_id: '77577086-4',
    name: 'COMERCIAL HUASCAR SPA',
    fantasy_name: null,
    address: 'ERNESTO RIQUELME 889',
    commune: 'Rengo',
    segment: 'A',
    priority: 'FOCO',
    lat: -34.4028,
    lng: -70.8622,
    last_visit_at: null
  },
  {
    id: 'c0002',
    external_id: 'COVADONGA4',
    name: 'FERRETERIA COVADONGA LTDA.',
    fantasy_name: null,
    address: 'Pedro Segundo Estrada 110, Rengo',
    commune: 'Rengo',
    segment: 'A',
    priority: 'FOCO',
    lat: -34.4058,
    lng: -70.8592,
    last_visit_at: null
  },
  {
    id: 'c0003',
    external_id: '77124337-1',
    name: 'SOC. COMERCIAL Y SERV. LOS ROBLES LTDA',
    fantasy_name: null,
    address: 'CALLE SAN MARTIN 163 EL ROSARIO RENGO',
    commune: 'Rosario',
    segment: 'A',
    priority: 'FOCO',
    lat: -34.3000,
    lng: -71.2167,
    last_visit_at: null
  },
  {
    id: 'c0004',
    external_id: '77961830-7',
    name: 'CARLOS VARGAS Y CIA LIMITADA',
    fantasy_name: null,
    address: 'MANUEL RODRIGUEZ 70',
    commune: 'Rengo',
    segment: 'B',
    priority: 'Normal',
    lat: -34.4048,
    lng: -70.8602,
    last_visit_at: null
  },
  {
    id: 'c0005',
    external_id: 'CHMAT72-2',
    name: 'CHILEMAT S.P.A / GARCIA RIO - RENGO',
    fantasy_name: 'GARCIA RIO - RENGO',
    address: 'ARTURO PRAT 485',
    commune: 'Rengo',
    segment: 'B',
    priority: 'Normal',
    lat: -34.4018,
    lng: -70.8632,
    last_visit_at: null
  },
  // SEMANA 1 - MARTES - Rancagua
  {
    id: 'c0006',
    external_id: 'PRODALAM11',
    name: 'PRODALAM S.A. / Rancagua',
    fantasy_name: 'PRODALAM RANCAGUA',
    address: 'Longitudinal Sur Km 91, Gultro Rancagua',
    commune: 'Rancagua',
    segment: 'A',
    priority: 'FOCO',
    lat: -34.1708,
    lng: -70.7444,
    last_visit_at: null
  },
  {
    id: 'c0007',
    external_id: 'ACENOR2',
    name: 'ACENOR ACEROS DEL NORTE S.A.',
    fantasy_name: null,
    address: 'Av. Republica de Chile 0530',
    commune: 'Rancagua',
    segment: 'A',
    priority: 'FOCO',
    lat: -34.1728,
    lng: -70.7464,
    last_visit_at: null
  },
  {
    id: 'c0008',
    external_id: 'MTS19-1',
    name: 'MTS / Ferrepersa',
    fantasy_name: 'Ferrepersa',
    address: 'Millan 45',
    commune: 'Rancagua',
    segment: 'A',
    priority: 'FOCO',
    lat: -34.1688,
    lng: -70.7424,
    last_visit_at: null
  },
  {
    id: 'c0009',
    external_id: '76181155-K',
    name: 'COMERCIAL ACEROS OHIGGINS LTDA',
    fantasy_name: null,
    address: 'ALAMEDA B.OHIGGINS 01425',
    commune: 'Rancagua',
    segment: 'B',
    priority: 'Normal',
    lat: -34.1698,
    lng: -70.7434,
    last_visit_at: null
  },
  // SEMANA 1 - MIERCOLES - Lolol / Doihue
  {
    id: 'c0010',
    external_id: '76053043-3',
    name: 'COMERCIAL IND. Y SERV. NEWEN LTDA',
    fantasy_name: null,
    address: 'AV. LOS AROMOS 260',
    commune: 'Lolol',
    segment: 'A',
    priority: 'FOCO',
    lat: -34.7281,
    lng: -71.6442,
    last_visit_at: null
  },
  {
    id: 'c0011',
    external_id: '77495861-4',
    name: 'FERRETERA DOIHUE SPA',
    fantasy_name: 'FERRETERA DOIHUE SPA',
    address: 'CARRETERA H 30 4451',
    commune: 'Doihue',
    segment: 'A',
    priority: 'FOCO',
    lat: -34.2333,
    lng: -70.8833,
    last_visit_at: null
  },
  // SEMANA 1 - JUEVES - Coltauco / Graneros
  {
    id: 'c0012',
    external_id: 'CHMAT29-3',
    name: 'CHILEMAT S.P.A. / Madesur Doihue',
    fantasy_name: 'Madesur Doihue',
    address: 'AV. CACHAPOAL 063',
    commune: 'Doihue',
    segment: 'A',
    priority: 'FOCO',
    lat: -34.2353,
    lng: -70.8853,
    last_visit_at: null
  },
  {
    id: 'c0013',
    external_id: '8614218-K',
    name: 'GUILLERMO MOLINA RUBIO',
    fantasy_name: null,
    address: 'CARRETERA H 30 4451',
    commune: 'Coltauco',
    segment: 'B',
    priority: 'Normal',
    lat: -34.2667,
    lng: -71.1000,
    last_visit_at: null
  },
  // SEMANA 1 - VIERNES - Graneros / Mostazal
  {
    id: 'c0014',
    external_id: 'CHMAT29-2',
    name: 'CHILEMAT S.P.A. / Madesur Graneros',
    fantasy_name: 'Madesur Graneros',
    address: 'Camino Real 30',
    commune: 'Graneros',
    segment: 'A',
    priority: 'FOCO',
    lat: -34.0667,
    lng: -70.7333,
    last_visit_at: null
  },
  {
    id: 'c0015',
    external_id: 'CHMAT29-1',
    name: 'CHILEMAT S.P.A. / Madesur San Francisco Mostazal',
    fantasy_name: 'Madesur',
    address: 'Panamericana Sur Km 62',
    commune: 'Mostazal',
    segment: 'A',
    priority: 'FOCO',
    lat: -33.9833,
    lng: -70.7000,
    last_visit_at: null
  },
  {
    id: 'c0016',
    external_id: 'CHMAT29-5',
    name: 'CHILEMAT S.P.A. / Madesur Requinoa',
    fantasy_name: 'Madesur Requinoa',
    address: 'Ruta H 409, Las Mercedes',
    commune: 'Requinoa',
    segment: 'A',
    priority: 'FOCO',
    lat: -34.2833,
    lng: -70.8167,
    last_visit_at: null
  },
  // SEMANA 2 - San Fernando / Santa Cruz
  {
    id: 'c0017',
    external_id: 'PRODALAM12',
    name: 'PRODALAM S.A. San Fernando',
    fantasy_name: 'PRODALAM SFERN',
    address: 'Av. Bernardo Ohiggins Sur 0400, San Fernando',
    commune: 'San Fernando',
    segment: 'A',
    priority: 'FOCO',
    lat: -34.5839,
    lng: -70.9894,
    last_visit_at: null
  },
  {
    id: 'c0018',
    external_id: 'REDMAT 24',
    name: 'REDMAT SPA CASA LUCERO LTDA, SANTA CRUZ',
    fantasy_name: 'CASA LUCERO LTDA, SANTA CRUZ',
    address: 'Cardenal Caro 111',
    commune: 'Santa Cruz',
    segment: 'A',
    priority: 'FOCO',
    lat: -34.6392,
    lng: -71.3647,
    last_visit_at: null
  },
  {
    id: 'c0019',
    external_id: '77905596-5',
    name: 'SOC. COMERCIAL LUCERO Y GOMEZ LTDA',
    fantasy_name: 'CASA LUCERO',
    address: 'CARDENAL CARO 111 VILLA HOSPITAL',
    commune: 'Santa Cruz',
    segment: 'B',
    priority: 'Normal',
    lat: -34.6412,
    lng: -71.3667,
    last_visit_at: null
  },
  {
    id: 'c0020',
    external_id: '76339578-2',
    name: 'SOC. CACERES FERRETERIA LTDA',
    fantasy_name: 'SOCIEDAD CACERES FERRETERIA LTDA',
    address: 'AVDA. ERRAZURIZ 781',
    commune: 'Santa Cruz',
    segment: 'B',
    priority: 'Normal',
    lat: -34.6372,
    lng: -71.3627,
    last_visit_at: null
  },
  // SEMANA 3 - Chimbarongo / Paredones
  {
    id: 'c0021',
    external_id: '77394356-7',
    name: 'FERRETERIA DONDE CARLITOS SPA',
    fantasy_name: 'FERRETERIA DONDE CARLITOS SPA',
    address: 'MIRAFLORES 611',
    commune: 'Chimbarongo',
    segment: 'A',
    priority: 'FOCO',
    lat: -34.7167,
    lng: -71.0333,
    last_visit_at: null
  },
  {
    id: 'c0022',
    external_id: '8918641-2',
    name: 'CLAUDIA ANTONIA PEREZ FUENTES',
    fantasy_name: null,
    address: 'Miraflores 1000-A',
    commune: 'Chimbarongo',
    segment: 'A',
    priority: 'FOCO',
    lat: -34.7187,
    lng: -71.0353,
    last_visit_at: null
  },
  {
    id: 'c0023',
    external_id: '15472852-K',
    name: 'RAUL ANDRES PEREZ AHUMADA',
    fantasy_name: null,
    address: 'AV DOCTOR MOORE 29 PAREDONES',
    commune: 'Paredones',
    segment: 'A',
    priority: 'FOCO',
    lat: -34.6500,
    lng: -71.9000,
    last_visit_at: null
  },
  // SEMANA 4 - San Vicente / Pichilemu
  {
    id: 'c0024',
    external_id: '76368507-1',
    name: 'SOC. COMERCIAL SANTOBEA LTDA.',
    fantasy_name: 'FONDON',
    address: 'ARTURO PRAT 1094',
    commune: 'San Vicente',
    segment: 'B',
    priority: 'Normal',
    lat: -34.4333,
    lng: -71.0833,
    last_visit_at: null
  },
  {
    id: 'c0025',
    external_id: '77159965-6',
    name: 'BROWN SANCHEZ ALIRO Y OTRO SPA',
    fantasy_name: 'BROWN SANCHEZ ALIRO Y OTRO SPA',
    address: 'AV. ESPANA 665',
    commune: 'San Vicente',
    segment: 'B',
    priority: 'Normal',
    lat: -34.4353,
    lng: -71.0853,
    last_visit_at: null
  },
  {
    id: 'c0026',
    external_id: 'PRODALAM42',
    name: 'PRODALAM S.A. San Vicente TT',
    fantasy_name: 'PRODALAM SAN VICENTE TT',
    address: 'German Riesco 490',
    commune: 'San Vicente',
    segment: 'B',
    priority: 'Normal',
    lat: -34.4313,
    lng: -71.0813,
    last_visit_at: null
  },
  {
    id: 'c0027',
    external_id: '77694807-1',
    name: 'FERRETERIA LOS NAVEGANTES',
    fantasy_name: 'FERRETERIA LOS NAVEGANTES',
    address: 'HERNANDO DE MAGALANES 1700',
    commune: 'Pichilemu',
    segment: 'B',
    priority: 'Normal',
    lat: -34.3833,
    lng: -72.0000,
    last_visit_at: null
  },
  // SEMANA 5 - Rancagua / Requinoa
  {
    id: 'c0028',
    external_id: '76198536-1',
    name: 'FERRETERIA SERGIO ESPINOZA EIRL',
    fantasy_name: 'SERGIO ESPINOZA',
    address: 'PABLO RUBIO 226',
    commune: 'Requinoa',
    segment: 'A',
    priority: 'FOCO',
    lat: -34.2853,
    lng: -70.8187,
    last_visit_at: null
  },
  // Más clientes representativos
  {
    id: 'c0029',
    external_id: '78190984-K',
    name: 'FERRETERIA SOC. HERMANOS FUENTES LTDA',
    fantasy_name: null,
    address: 'Rengo Centro',
    commune: 'Rengo',
    segment: 'C',
    priority: 'Normal',
    lat: -34.4008,
    lng: -70.8642,
    last_visit_at: null
  },
  {
    id: 'c0030',
    external_id: '77007199-2',
    name: 'FERRETERA DIMAFERR W. DROGUETT E.I.R.L.',
    fantasy_name: 'FERRETERA DIMAFERR',
    address: 'AV. REPUBLICA DE CHILE 01816',
    commune: 'Rancagua',
    segment: 'B',
    priority: 'Normal',
    lat: -34.1738,
    lng: -70.7474,
    last_visit_at: null
  }
];

const mockProducts = [
  {
    id: 'p1111111-1111-1111-1111-111111111111',
    sku: 'LK-TALADRO-001',
    name: 'Taladro Percutor 750W',
    base_cost: 25000,
    list_price: 45990
  },
  {
    id: 'p2222222-2222-2222-2222-222222222222',
    sku: 'LK-SIERRA-002',
    name: 'Sierra Circular 1200W',
    base_cost: 35000,
    list_price: 62990
  },
  {
    id: 'p3333333-3333-3333-3333-333333333333',
    sku: 'LK-LIJADORA-003',
    name: 'Lijadora Orbital 300W',
    base_cost: 15000,
    list_price: 28990
  },
  {
    id: 'p4444444-4444-4444-4444-444444444444',
    sku: 'LK-ESMERIL-004',
    name: 'Esmeril Angular 4 1/2"',
    base_cost: 18000,
    list_price: 32990
  },
  {
    id: 'p5555555-5555-5555-5555-555555555555',
    sku: 'LK-ATORNILL-005',
    name: 'Atornillador Inalambrico 12V',
    base_cost: 22000,
    list_price: 39990
  }
];

const mockCompetitors = [
  { id: 'comp-1111', name: 'Sodimac', website_url: 'https://sodimac.cl' },
  { id: 'comp-2222', name: 'Easy', website_url: 'https://easy.cl' },
  { id: 'comp-3333', name: 'Construmart', website_url: 'https://construmart.cl' },
  { id: 'comp-4444', name: 'MTS Chile', website_url: 'https://mts.cl' }
];

const mockPriceIntelligence = [
  {
    id: 'pi-001',
    product_id: 'p1111111-1111-1111-1111-111111111111',
    competitor_id: 'comp-1111',
    detected_price: 42990,
    captured_at: '2024-01-25T10:00:00Z',
    source: 'n8n_scraper',
    evidence_url: null
  },
  {
    id: 'pi-002',
    product_id: 'p1111111-1111-1111-1111-111111111111',
    competitor_id: 'comp-2222',
    detected_price: 44990,
    captured_at: '2024-01-25T10:05:00Z',
    source: 'n8n_scraper',
    evidence_url: null
  },
  {
    id: 'pi-003',
    product_id: 'p2222222-2222-2222-2222-222222222222',
    competitor_id: 'comp-1111',
    detected_price: 59990,
    captured_at: '2024-01-25T09:30:00Z',
    source: 'n8n_scraper',
    evidence_url: null
  },
  {
    id: 'pi-004',
    product_id: 'p4444444-4444-4444-4444-444444444444',
    competitor_id: 'comp-3333',
    detected_price: 29990,
    captured_at: '2024-01-25T11:00:00Z',
    source: 'n8n_scraper',
    evidence_url: null
  }
];

// Datos dinamicos (se modifican en runtime)
// Ruta de prueba para D. Taricco - Hoy
const today = new Date().toISOString().split('T')[0];

let mockDailyRoutes = [
  {
    id: 'route-demo-001',
    user_id: '11111111-1111-1111-1111-111111111111',
    vehicle_id: 'aaaa1111-1111-1111-1111-111111111111',
    date: today,
    start_km: 45230,
    end_km: null,
    total_cost_clp: null,
    status: 'active',
    created_at: new Date().toISOString()
  }
];

// Visitas de prueba para la ruta de hoy
let mockVisits = [
  {
    id: 'visit-001',
    route_id: 'route-demo-001',
    client_id: 'c0001',
    check_in: new Date(Date.now() - 3600000 * 4).toISOString(),
    check_out: new Date(Date.now() - 3600000 * 3.5).toISOString(),
    outcome: 'sale',
    audio_url: null,
    ai_summary: 'Venta exitosa de taladros y lijadoras'
  },
  {
    id: 'visit-002',
    route_id: 'route-demo-001',
    client_id: 'c0002',
    check_in: new Date(Date.now() - 3600000 * 3).toISOString(),
    check_out: new Date(Date.now() - 3600000 * 2.5).toISOString(),
    outcome: 'sale',
    audio_url: null,
    ai_summary: 'Pedido de reposicion sierras'
  },
  {
    id: 'visit-003',
    route_id: 'route-demo-001',
    client_id: 'c0004',
    check_in: new Date(Date.now() - 3600000 * 2).toISOString(),
    check_out: new Date(Date.now() - 3600000 * 1.5).toISOString(),
    outcome: 'no_stock',
    audio_url: null,
    ai_summary: 'Sin stock, agendar para proxima semana'
  },
  {
    id: 'visit-004',
    route_id: 'route-demo-001',
    client_id: 'c0005',
    check_in: new Date(Date.now() - 3600000 * 1).toISOString(),
    check_out: null,
    outcome: 'pending',
    audio_url: null,
    ai_summary: null
  }
];

module.exports = {
  mockUsers,
  mockVehicles,
  mockClients,
  mockProducts,
  mockCompetitors,
  mockPriceIntelligence,
  mockDailyRoutes,
  mockVisits,
  comunaCoords
};
