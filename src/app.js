require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');

// Import services
const { supabase } = require('./config/database');
const routesService = require('./modules/routes/routes.service');
const intelligenceService = require('./modules/market-intelligence/intelligence.service');
const n8nService = require('./services/n8n.service');
const googleSheetsService = require('./services/googleSheets.service');
const cneService = require('./services/cne.service');

// Auth + Security
const authRouter = require('./modules/auth/auth.controller');
const { authenticate, authorize } = require('./middlewares/auth');
const { webhookAuth } = require('./middlewares/webhookAuth');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const helmet = require('helmet');

const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 30,
  keyGenerator: (req) => req.user?.id || ipKeyGenerator(req),
  message: { success: false, error: 'Límite de consultas IA alcanzado. Intenta en 1 hora.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// OpenAI
const OpenAI = require('openai');
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// AI Usage Tracker — persiste en memoria por sesión de servidor
const _aiUsage = {
  totalRequests: 0,
  totalTokens: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  byEndpoint: {},
  byUser: {},
  history: [], // últimas 50 llamadas
  serverStartedAt: new Date().toISOString()
};

function _trackAiUsage(endpoint, userId, userName, usage) {
  const tokens = usage?.total_tokens || 0;
  const input = usage?.prompt_tokens || 0;
  const output = usage?.completion_tokens || 0;
  _aiUsage.totalRequests++;
  _aiUsage.totalTokens += tokens;
  _aiUsage.totalInputTokens += input;
  _aiUsage.totalOutputTokens += output;

  if (!_aiUsage.byEndpoint[endpoint]) _aiUsage.byEndpoint[endpoint] = { requests: 0, tokens: 0 };
  _aiUsage.byEndpoint[endpoint].requests++;
  _aiUsage.byEndpoint[endpoint].tokens += tokens;

  if (userId) {
    if (!_aiUsage.byUser[userId]) _aiUsage.byUser[userId] = { name: userName || userId, requests: 0, tokens: 0 };
    _aiUsage.byUser[userId].requests++;
    _aiUsage.byUser[userId].tokens += tokens;
  }

  _aiUsage.history.unshift({
    endpoint, user: userName || userId, tokens, input, output,
    model: 'gpt-4o', timestamp: new Date().toISOString()
  });
  if (_aiUsage.history.length > 50) _aiUsage.history.length = 50;
}

const app = express();

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB max
});

// CORS: solo orígenes propios en producción
const corsOrigins = process.env.NODE_ENV === 'production'
  ? (process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : true)
  : true; // dev: permitir todo
app.use(cors({ origin: corsOrigins, credentials: true }));

// Security headers (Helmet) — desactivar CSP para no romper inline scripts del SPA
app.use(helmet({
  contentSecurityPolicy: false,  // El SPA usa scripts inline; CSP requiere refactor mayor
  crossOriginEmbedderPolicy: false,
}));

app.use(express.json());

// Force no-cache on service-worker.js and index.html so updates propagate immediately
app.use((req, res, next) => {
  if (req.path === '/service-worker.js' || req.path === '/' || req.path === '/index.html') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// =============================================
// AUTH ROUTES (public - no middleware)
// =============================================
app.use('/api/auth', authRouter);

// =============================================
// AUTH MIDDLEWARE - Protect all API & routes
// Excludes: /api/auth/*, /webhooks/*, /health, static files
// =============================================
app.use('/api', (req, res, next) => {
  // Skip auth for /api/auth/* routes (login, setup, check-setup)
  if (req.path.startsWith('/auth')) return next();
  // Skip auth for webhook push desde Apps Script (tiene su propio secret)
  if (req.path === '/gsheets/push' || req.path === '/gsheets/last-push') return next();
  authenticate(req, res, next);
});
app.use('/routes', authenticate);

// =============================================
// SHEETS CONTEXT CACHE — para LEKER AI
// Lee Ventas, Cobranzas, 80-20 y genera resumen para el sistema prompt
// TTL: 5 minutos
// =============================================
let _sheetsCache = { data: null, ts: 0 };
const SHEETS_CACHE_TTL = 5 * 60 * 1000;

async function _buildSheetsContext() {
  const now = Date.now();
  if (_sheetsCache.data && (now - _sheetsCache.ts) < SHEETS_CACHE_TTL) {
    return _sheetsCache.data;
  }
  if (!googleSheetsService.isConfigured()) return '';

  const parseNum = s => parseFloat(String(s || '').replace(/\./g, '').replace(',', '.')) || 0;
  const fmt = n => '$' + Math.round(n).toLocaleString('es-CL');

  try {
    const [ventasRows, cobranzasRows, rows8020] = await Promise.all([
      googleSheetsService.getSheet('Ventas por Mes Clientes').catch(() => []),
      googleSheetsService.getSheet('Cobranzas').catch(() => []),
      googleSheetsService.getSheet('80-20 Vendedores').catch(() => []),
    ]);

    let ctx = '';

    // ── VENTAS ──────────────────────────────────────────────────────────────
    // Row 0: vacía, Row 1: headers, Row 2+: datos
    // Cols: 0=Cod, 1=Nombre, 5=Total Neto$, 6=Vendedor, 7=Mes, 8=Año, 9=Zona
    const ventasByVendedor = {}; // { vendedor: { 'mes/año': total } }
    const ventasByMes = {};
    const topClients = {};
    const topClientsByVendedor = {}; // { vendedor: { cliente: total } }

    for (const row of ventasRows.slice(2)) {
      if (!row || row.length < 9) continue;
      const vendedor = (row[6] || '').trim() || 'Sin vendedor';
      const mes = (row[7] || '').trim();
      const anio = (row[8] || '').trim();
      const total = parseNum(row[5]);
      const nombre = (row[1] || '').trim();
      if (!mes || !anio || total === 0) continue;
      const mk = `${mes}/${anio}`;
      if (!ventasByVendedor[vendedor]) ventasByVendedor[vendedor] = {};
      ventasByVendedor[vendedor][mk] = (ventasByVendedor[vendedor][mk] || 0) + total;
      ventasByMes[mk] = (ventasByMes[mk] || 0) + total;
      if (nombre) {
        topClients[nombre] = (topClients[nombre] || 0) + total;
        if (!topClientsByVendedor[vendedor]) topClientsByVendedor[vendedor] = {};
        topClientsByVendedor[vendedor][nombre] = (topClientsByVendedor[vendedor][nombre] || 0) + total;
      }
    }

    const mesesSorted = Object.entries(ventasByMes)
      .sort((a, b) => {
        const [ma, ya] = a[0].split('/'); const [mb, yb] = b[0].split('/');
        return (parseInt(yb) * 12 + parseInt(mb)) - (parseInt(ya) * 12 + parseInt(ma));
      }).slice(0, 4);

    ctx += '\n=== VENTAS (Google Sheet — datos reales) ===\n';
    ctx += 'Totales por período:\n';
    for (const [mk, mv] of mesesSorted) {
      const [m, y] = mk.split('/');
      ctx += `  Mes ${m}/${y}: ${fmt(mv)}\n`;
    }
    ctx += 'Por vendedor (períodos recientes):\n';
    for (const [vend, meses] of Object.entries(ventasByVendedor)) {
      const totalVend = Object.values(meses).reduce((a, b) => a + b, 0);
      const detalles = mesesSorted.map(([mk]) => meses[mk] ? `${mk.replace('/', '-')}: ${fmt(meses[mk])}` : null).filter(Boolean).join(' | ');
      ctx += `  ${vend}: total=${fmt(totalVend)}${detalles ? ' | ' + detalles : ''}\n`;
    }
    const topClientsSorted = Object.entries(topClients).sort((a, b) => b[1] - a[1]).slice(0, 10);
    ctx += 'Top 10 clientes por venta acumulada:\n';
    topClientsSorted.forEach(([n, v], i) => { ctx += `  ${i + 1}. ${n}: ${fmt(v)}\n`; });
    ctx += 'Top 5 clientes por vendedor:\n';
    for (const [vend, clientes] of Object.entries(topClientsByVendedor)) {
      const top5 = Object.entries(clientes).sort((a, b) => b[1] - a[1]).slice(0, 5);
      ctx += `  ${vend}:\n`;
      top5.forEach(([n, v], i) => { ctx += `    ${i + 1}. ${n}: ${fmt(v)}\n`; });
    }

    // ── COBRANZAS ────────────────────────────────────────────────────────────
    // Row 0: vacía, Row 1: vacía, Row 2: headers, Row 3+: datos
    // Cols: 0=Cod, 2=Nombre, 4=FechaVenc, 5=Saldo, 6=Vendedor
    const cobrData = cobranzasRows.slice(3).filter(r => r && r[2]);
    const cobByVendedor = {};
    let totalCob = 0;

    for (const row of cobrData) {
      const vendedor = (row[6] || '').trim() || 'Sin vendedor';
      const saldo = parseNum(row[5]);
      const nombre = (row[2] || '').trim();
      const vencimiento = (row[4] || '').trim();
      if (!cobByVendedor[vendedor]) cobByVendedor[vendedor] = { total: 0, count: 0, items: [] };
      cobByVendedor[vendedor].total += saldo;
      cobByVendedor[vendedor].count++;
      cobByVendedor[vendedor].items.push({ nombre, saldo, vencimiento });
      totalCob += saldo;
    }

    ctx += `\n=== COBRANZAS PENDIENTES (Google Sheet — datos reales) ===\n`;
    ctx += `Total general: ${fmt(totalCob)} (${cobrData.length} documentos)\n`;
    for (const [vend, info] of Object.entries(cobByVendedor)) {
      ctx += `  ${vend}: ${fmt(info.total)} (${info.count} docs)\n`;
    }
    const topCob = cobrData
      .map(r => ({ nombre: (r[2] || '').trim(), saldo: parseNum(r[5]), vendedor: (r[6] || '?').trim(), vencimiento: (r[4] || '').trim() }))
      .sort((a, b) => b.saldo - a.saldo).slice(0, 8);
    ctx += 'Mayores cobranzas pendientes:\n';
    topCob.forEach((p, i) => { ctx += `  ${i + 1}. ${p.nombre} (${p.vendedor}): ${fmt(p.saldo)} — vence ${p.vencimiento}\n`; });

    // ── 80-20 ─────────────────────────────────────────────────────────────
    // Headers: Ranking, Cliente, Nombre, FINAL (vendedor), Segmento
    const data8020 = rows8020.slice(1).filter(r => r && r[1]);
    ctx += `\n=== CLIENTES 80-20 (Google Sheet) ===\n`;
    ctx += `Total: ${data8020.length} clientes\n`;
    const by8020Vend = {};
    for (const row of data8020) {
      const v = (row[3] || '?').trim();
      by8020Vend[v] = (by8020Vend[v] || 0) + 1;
    }
    for (const [v, c] of Object.entries(by8020Vend)) { ctx += `  ${v}: ${c} clientes 80-20\n`; }

    _sheetsCache = { data: ctx, ts: now };
    return ctx;
  } catch (e) {
    console.error('[SheetsContext]', e.message);
    return '';
  }
}

// =============================================
// CONFIGURACIÓN - Precio bencina (en memoria)
// =============================================
let fuelPriceConfig = {
  price: 1141,        // CLP/litro - Bencina 93 octanos Chile
  updatedAt: new Date().toISOString(),
  updatedBy: 'system'
};

app.get('/api/config/fuel-price', async (req, res) => {
  try {
    // Try CNE API first (if configured)
    if (cneService.isConfigured()) {
      const cnePrice = await cneService.getFuelPrice();
      if (cnePrice) {
        fuelPriceConfig = {
          price: cnePrice.price,
          minPrice: cnePrice.minPrice,
          maxPrice: cnePrice.maxPrice,
          stationsCount: cnePrice.stationsCount,
          source: 'CNE API',
          updatedAt: cnePrice.updatedAt,
          updatedBy: 'CNE API'
        };
        // Propagate to routes service
        routesService.updateFuelPrice(cnePrice.price);
      }
    }
    res.json({ success: true, data: fuelPriceConfig });
  } catch (error) {
    // Fallback to current config
    res.json({ success: true, data: fuelPriceConfig });
  }
});

app.get('/api/config/fuel-prices-by-region', async (req, res) => {
  try {
    // Try CNE API (if configured)
    if (cneService.isConfigured()) {
      const regionalData = await cneService.getFuelPricesByRegion();
      if (regionalData) {
        return res.json({ success: true, data: regionalData });
      }
    }
    // Fallback: no regional data available
    res.json({
      success: false,
      error: 'CNE API no configurado o sin datos regionales disponibles',
      data: null
    });
  } catch (error) {
    console.error('[API] Error fetching regional prices:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/config/fuel-price', authorize('admin'), (req, res) => {
  try {
    const { price } = req.body;
    if (!price || typeof price !== 'number' || price < 0 || price > 5000) {
      return res.status(400).json({ success: false, error: 'Precio inválido (debe ser 0-5000 CLP)' });
    }
    fuelPriceConfig = {
      price: Math.round(price),
      updatedAt: new Date().toISOString(),
      updatedBy: req.user?.name || 'admin'
    };
    res.json({ success: true, data: fuelPriceConfig, message: 'Precio bencina actualizado' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// AI ASSISTANT (OpenAI / ChatGPT)
// =============================================
app.post('/api/assistant/chat', authenticate, aiLimiter, async (req, res) => {
  try {
    const { message, context, history } = req.body;

    if (!process.env.OPENAI_API_KEY) {
      return res.status(400).json({
        success: false,
        error: 'Asistente IA no configurado. Agrega OPENAI_API_KEY en .env'
      });
    }

    if (!message || typeof message !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Se requiere un mensaje válido'
      });
    }

    // Build system prompt with context
    const systemPrompt = `Eres un asistente de IA para el sistema logístico de LEKER, una empresa de distribución en Chile.

CONTEXTO DEL SISTEMA:
- Base de datos: Supabase (PostgreSQL)
- Tablas principales: users, clients, vehicles, daily_routes, visits, products, scheduled_routes
- Funcionalidades: Gestión de vendedores, rutas optimizadas, tracking GPS, control de visitas, costos de combustible

DATOS ACTUALES:
${context ? `- Total vendedores: ${context.totalVendedores || 0}
- Total clientes: ${context.totalClientes || 0}
- Rutas activas hoy: ${context.rutasHoy || 0}
- Fecha: ${context.fecha || new Date().toLocaleDateString('es-CL')}` : ''}

CAPACIDADES:
- Explicar funcionalidades del sistema
- Consultas sobre vendedores, clientes, rutas y vehículos
- Ayuda con planificación de rutas y optimización
- Información sobre costos de combustible y rendimiento
- Guía de uso del sistema

IMPORTANTE:
- Responde en español de forma concisa y profesional
- Si no tienes información suficiente, indica qué datos necesitas
- Sugiere acciones concretas cuando sea posible
- Usa un tono amable pero profesional`;

    // Build messages array (OpenAI format: system + user/assistant)
    const messages = [
      { role: 'system', content: systemPrompt }
    ];

    // Add conversation history if provided (last 10 messages)
    if (history && Array.isArray(history) && history.length > 0) {
      history.slice(-10).forEach(msg => {
        if (msg.role === 'user' || msg.role === 'assistant') {
          messages.push({
            role: msg.role,
            content: msg.content
          });
        }
      });
    }

    // Add current message
    messages.push({
      role: 'user',
      content: message
    });

    // Call OpenAI ChatGPT API
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o',
        max_tokens: 1024,
        temperature: 0.7,
        messages: messages
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('OpenAI API error:', error);
      return res.status(500).json({
        success: false,
        error: 'Error al comunicarse con ChatGPT'
      });
    }

    const data = await response.json();
    const assistantMessage = data.choices[0].message.content;

    res.json({
      success: true,
      data: {
        response: assistantMessage
      }
    });

  } catch (error) {
    console.error('AI Assistant error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =============================================
// API ENDPOINTS - DATOS AUXILIARES (para UI)
// =============================================

app.get('/api/users', authorize('admin'), async (req, res) => {
  try {
    const data = await routesService.getAllUsers();
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/vehicles', async (req, res) => {
  try {
    const data = await routesService.getAllVehicles();
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/clients', async (req, res) => {
  try {
    const data = await routesService.getAllClients();
    res.json({ success: true, data, total: data.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/clients/count', async (req, res) => {
  try {
    const count = await routesService.getClientCount();
    res.json({ success: true, count });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/clients', async (req, res) => {
  try {
    const userId = req.user ? req.user.id : null;
    const client = await routesService.createClient(req.body, userId);
    res.status(201).json({ success: true, message: 'Cliente creado', data: client });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.put('/api/clients/:id', async (req, res) => {
  try {
    const userId = req.user ? req.user.id : null;
    const result = await routesService.updateClient(req.params.id, req.body, userId);
    const { _sheetSync, _scriptConfigured, ...client } = result;
    res.json({ success: true, message: 'Cliente actualizado', data: client, sheetSync: _sheetSync, scriptConfigured: _scriptConfigured });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Sync explícito de un cliente al Google Sheet
app.post('/api/clients/:id/sync-to-sheet', authorize('admin', 'supervisor'), async (req, res) => {
  try {
    const client = await routesService.getClientById(req.params.id);
    if (!client) return res.status(404).json({ success: false, error: 'Cliente no encontrado' });
    const userId = req.user ? req.user.id : null;
    const result = await routesService._syncClientToSheet(client, userId);
    res.json({ success: true, sheetResult: result, scriptUrl: process.env.GOOGLE_SHEETS_SCRIPT_URL ? 'configurado' : 'NO CONFIGURADO' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Sync deletions: elimina clientes en DB que ya no están en GSheets
app.post('/api/clients/sync-deletions', authorize('admin', 'supervisor'), async (req, res) => {
  try {
    const { externalIds } = req.body;
    if (!Array.isArray(externalIds) || externalIds.length === 0) {
      return res.status(400).json({ success: false, error: 'externalIds requerido' });
    }
    const result = await routesService.syncDeletions(externalIds);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/clients/:id', async (req, res) => {
  try {
    await routesService.deleteClient(req.params.id);
    res.json({ success: true, message: 'Cliente eliminado' });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Geocodificar cliente (actualiza lat/lng usando su dirección actual)
app.post('/api/clients/:id/geocode', authorize('admin', 'supervisor', 'executive'), async (req, res) => {
  try {
    // forceAddress=true cuando viene de una edición de dirección — ignora geo_link viejo
    const forceAddress = req.body?.forceAddress === true;
    const result = await routesService.geocodeClient(req.params.id, { forceAddress });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Geocodificación masiva — procesa todos los clientes sin GPS que tienen dirección
app.post('/api/clients/geocode-batch', authorize('admin'), async (req, res) => {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Obtener clientes sin GPS pero con dirección
    const { data: clients, error } = await supabase
      .from('clients')
      .select('id, address, commune, city, region')
      .is('lat', null)
      .not('address', 'is', null)
      .neq('address', '');

    if (error) throw error;

    let ok = 0, failed = 0;
    for (const c of clients) {
      try {
        await routesService.geocodeClient(c.id);
        ok++;
        // Pausa 120ms entre llamadas para no superar límite Google Maps API (10 req/s)
        await new Promise(r => setTimeout(r, 120));
      } catch (_e) {
        failed++;
      }
    }

    res.json({ success: true, total: clients.length, ok, failed });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/clients/import-from-sheets', authorize('admin'), async (req, res) => {
  try {
    const { rows } = req.body;
    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ success: false, error: 'Se requiere array de rows' });
    }
    const result = await routesService.importClientsFromSheets(rows);
    res.json({ success: true, message: `Importación completada`, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/clients/reassign', authorize('admin', 'supervisor'), async (req, res) => {
  try {
    const { fromUserId, toUserId } = req.body;
    if (!fromUserId || !toUserId) {
      return res.status(400).json({ success: false, error: 'Se requiere vendedor origen y destino' });
    }
    if (fromUserId === toUserId) {
      return res.status(400).json({ success: false, error: 'El vendedor origen y destino no pueden ser el mismo' });
    }
    const result = await routesService.reassignClients(fromUserId, toUserId);
    res.json({ success: true, message: 'Clientes reasignados', data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.get('/api/products', async (req, res) => {
  try {
    const data = await intelligenceService.getAllProducts();
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/competitors', async (req, res) => {
  try {
    const data = await intelligenceService.getAllCompetitors();
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/daily-routes', async (req, res) => {
  try {
    const data = await routesService.getAllRoutes();
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/daily-routes/today', async (req, res) => {
  try {
    const data = await routesService.getTodayRoutes();
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/daily-routes/:routeId', async (req, res) => {
  try {
    const route = await routesService.getRouteWithVisits(req.params.routeId);
    if (!route) {
      return res.status(404).json({ success: false, error: 'Ruta no encontrada' });
    }
    res.json({ success: true, data: route });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/users/:userId/routes', async (req, res) => {
  try {
    const data = await routesService.getRoutesByUser(req.params.userId);
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/price-intelligence', async (req, res) => {
  try {
    const data = await intelligenceService.getAllPrices();
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// GESTIÓN DE VENDEDORES
// =============================================

app.post('/api/users', authorize('admin'), async (req, res) => {
  try {
    const { fullName, email, role } = req.body;
    if (!fullName || !email) {
      return res.status(400).json({ success: false, error: 'Nombre y email son requeridos' });
    }
    const user = await routesService.createUser({ fullName, email, role });
    res.status(201).json({ success: true, message: 'Vendedor creado', data: user });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.delete('/api/users/:id', authorize('admin'), async (req, res) => {
  try {
    await routesService.deleteUser(req.params.id);
    res.json({ success: true, message: 'Vendedor eliminado' });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.put('/api/users/:id', authorize('admin'), async (req, res) => {
  try {
    const user = await routesService.updateUser(req.params.id, req.body);
    res.json({ success: true, message: 'Usuario actualizado', data: user });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Obtener clientes asignados a un vendedor
app.get('/api/users/:id/clients', async (req, res) => {
  try {
    const data = await routesService.getClientsByUser(req.params.id);
    res.json({ success: true, data, total: data.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Asignar zona a un vendedor
app.put('/api/users/:id/zone', authorize('admin'), async (req, res) => {
  try {
    const { zone, zone_leader } = req.body;
    const user = await routesService.updateUserZone(req.params.id, zone, zone_leader);
    res.json({ success: true, message: 'Zona asignada', data: user });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Listar zonas con sus lideres y vendedores
app.get('/api/zones', async (req, res) => {
  try {
    const data = await routesService.getZones();
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Reasignar clientes seleccionados
app.post('/api/clients/reassign-selected', authorize('admin', 'supervisor'), async (req, res) => {
  try {
    const { clientIds, toUserId } = req.body;
    if (!clientIds || !Array.isArray(clientIds) || clientIds.length === 0) {
      return res.status(400).json({ success: false, error: 'Se requiere lista de clientes' });
    }
    if (!toUserId) {
      return res.status(400).json({ success: false, error: 'Se requiere vendedor destino' });
    }
    const result = await routesService.reassignSelectedClients(clientIds, toUserId);
    res.json({ success: true, message: 'Clientes reasignados', data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// =============================================
// GESTIÓN DE VEHÍCULOS
// =============================================

app.post('/api/vehicles', async (req, res) => {
  try {
    const { licensePlate, model, fuelEfficiency } = req.body;
    if (!licensePlate || !model) {
      return res.status(400).json({ success: false, error: 'Patente y modelo son requeridos' });
    }
    const vehicle = await routesService.createVehicle({ licensePlate, model, fuelEfficiency });
    res.status(201).json({ success: true, message: 'Vehículo creado', data: vehicle });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.delete('/api/vehicles/:id', async (req, res) => {
  try {
    await routesService.deleteVehicle(req.params.id);
    res.json({ success: true, message: 'Vehículo eliminado' });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.patch('/api/vehicles/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const vehicle = await routesService.updateVehicleStatus(req.params.id, status);
    res.json({ success: true, message: 'Estado actualizado', data: vehicle });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.put('/api/vehicles/:id', async (req, res) => {
  try {
    const vehicle = await routesService.updateVehicle(req.params.id, req.body);
    res.json({ success: true, message: 'Vehículo actualizado', data: vehicle });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// =============================================
// IMPORTACIÓN DE EXCEL
// =============================================

app.post('/api/upload/clients', authorize('admin', 'supervisor'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No se envió archivo' });
    }

    // Parse Excel file
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });

    // Get sheet names
    const sheetNames = workbook.SheetNames;

    // Try to find clients data
    let clientsData = [];

    // Check for 'Direcciones' sheet or first sheet
    const sheetName = sheetNames.includes('Direcciones') ? 'Direcciones' : sheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    // Find header row (look for common column names)
    let headerRow = 0;
    for (let i = 0; i < Math.min(10, rawData.length); i++) {
      const row = rawData[i] || [];
      const rowStr = row.join(' ').toLowerCase();
      if (rowStr.includes('codigo') || rowStr.includes('código') || rowStr.includes('rut') || rowStr.includes('nombre')) {
        headerRow = i;
        break;
      }
    }

    const headers = (rawData[headerRow] || []).map(h =>
      String(h || '').toLowerCase().trim()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, '_')
    );

    // Map common column names
    const colMap = {
      codigo: headers.findIndex(h => h.includes('codigo') || h.includes('external')),
      name: headers.findIndex(h => h.includes('razon') || h.includes('nombre') || h.includes('name')),
      fantasy: headers.findIndex(h => h.includes('fantasia') || h.includes('fantasy')),
      address: headers.findIndex(h => h.includes('direccion') || h.includes('address')),
      commune: headers.findIndex(h => h.includes('comuna') || h.includes('commune')),
      segment: headers.findIndex(h => h.includes('segmento') || h.includes('segment')),
      priority: headers.findIndex(h => h.includes('prioridad') || h.includes('priority') || h.includes('foco'))
    };

    // Process rows
    const results = { inserted: 0, updated: 0, errors: [] };

    for (let i = headerRow + 1; i < rawData.length; i++) {
      const row = rawData[i];
      if (!row || row.length === 0) continue;

      const getValue = (idx) => idx >= 0 && row[idx] ? String(row[idx]).trim() : '';

      const codigo = getValue(colMap.codigo);
      if (!codigo) continue;

      const clientData = {
        external_id: codigo,
        name: getValue(colMap.name) || `Cliente ${codigo}`,
        fantasy_name: getValue(colMap.fantasy),
        address: getValue(colMap.address),
        commune: getValue(colMap.commune),
        segment: getValue(colMap.segment) || 'C',
        priority: getValue(colMap.priority) || 'Normal'
      };

      // Validate segment
      if (!['A', 'B', 'C'].includes(clientData.segment.toUpperCase())) {
        clientData.segment = 'C';
      } else {
        clientData.segment = clientData.segment.toUpperCase();
      }

      clientsData.push(clientData);
    }

    // Insert/Update in database based on mode
    const mode = req.body.mode || 'upsert';
    const imported = mode === 'replace'
      ? await routesService.replaceClients(clientsData)
      : await routesService.upsertClients(clientsData);

    res.json({
      success: true,
      message: `Importación completada`,
      data: {
        sheet: sheetName,
        totalRows: clientsData.length,
        mode,
        ...imported
      }
    });

  } catch (error) {
    console.error('Error uploading file:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Upload Users (Ejecutivos)
app.post('/api/upload/users', authorize('admin'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No se envió archivo' });
    }

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    // Find header row
    let headerRow = 0;
    for (let i = 0; i < Math.min(10, rawData.length); i++) {
      const row = rawData[i] || [];
      const rowStr = row.join(' ').toLowerCase();
      if (rowStr.includes('nombre') || rowStr.includes('email') || rowStr.includes('correo')) {
        headerRow = i;
        break;
      }
    }

    const headers = (rawData[headerRow] || []).map(h =>
      String(h || '').toLowerCase().trim()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, '_')
    );

    const colMap = {
      name: headers.findIndex(h => h.includes('nombre') || h.includes('name')),
      email: headers.findIndex(h => h.includes('email') || h.includes('correo')),
      role: headers.findIndex(h => h.includes('rol') || h.includes('role') || h.includes('cargo'))
    };

    const usersData = [];
    for (let i = headerRow + 1; i < rawData.length; i++) {
      const row = rawData[i];
      if (!row || row.length === 0) continue;

      const getValue = (idx) => idx >= 0 && row[idx] ? String(row[idx]).trim() : '';

      const name = getValue(colMap.name);
      const email = getValue(colMap.email);

      if (!name && !email) continue;

      usersData.push({
        full_name: name || 'Sin nombre',
        email: email || `${name.toLowerCase().replace(/\s+/g, '.')}@leker.cl`,
        role: getValue(colMap.role) || 'executive'
      });
    }

    const mode = req.body.mode || 'upsert';
    const imported = mode === 'replace'
      ? await routesService.replaceUsers(usersData)
      : await routesService.upsertUsers(usersData);

    res.json({
      success: true,
      message: `Importación completada`,
      data: {
        sheet: sheetName,
        totalRows: usersData.length,
        mode,
        ...imported
      }
    });

  } catch (error) {
    console.error('Error uploading users:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Upload Vehicles (Vehículos)
app.post('/api/upload/vehicles', authorize('admin', 'supervisor'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No se envió archivo' });
    }

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    // Find header row
    let headerRow = 0;
    for (let i = 0; i < Math.min(10, rawData.length); i++) {
      const row = rawData[i] || [];
      const rowStr = row.join(' ').toLowerCase();
      if (rowStr.includes('patente') || rowStr.includes('placa') || rowStr.includes('modelo')) {
        headerRow = i;
        break;
      }
    }

    const headers = (rawData[headerRow] || []).map(h =>
      String(h || '').toLowerCase().trim()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, '_')
    );

    const colMap = {
      plate: headers.findIndex(h => h.includes('patente') || h.includes('placa') || h.includes('plate')),
      model: headers.findIndex(h => h.includes('modelo') || h.includes('model')),
      efficiency: headers.findIndex(h => h.includes('rendimiento') || h.includes('efficiency') || h.includes('km/l'))
    };

    const vehiclesData = [];
    for (let i = headerRow + 1; i < rawData.length; i++) {
      const row = rawData[i];
      if (!row || row.length === 0) continue;

      const getValue = (idx) => idx >= 0 && row[idx] ? String(row[idx]).trim() : '';

      const plate = getValue(colMap.plate);
      if (!plate) continue;

      vehiclesData.push({
        license_plate: plate.toUpperCase(),
        model: getValue(colMap.model) || 'Sin modelo',
        fuel_efficiency_kml: parseFloat(getValue(colMap.efficiency)) || 12,
        status: 'active'
      });
    }

    const mode = req.body.mode || 'upsert';
    const imported = mode === 'replace'
      ? await routesService.replaceVehicles(vehiclesData)
      : await routesService.upsertVehicles(vehiclesData);

    res.json({
      success: true,
      message: `Importación completada`,
      data: {
        sheet: sheetName,
        totalRows: vehiclesData.length,
        mode,
        ...imported
      }
    });

  } catch (error) {
    console.error('Error uploading vehicles:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Upload Products (Productos)
app.post('/api/upload/products', authorize('admin', 'supervisor'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No se envió archivo' });
    }

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    // Find header row
    let headerRow = 0;
    for (let i = 0; i < Math.min(10, rawData.length); i++) {
      const row = rawData[i] || [];
      const rowStr = row.join(' ').toLowerCase();
      if (rowStr.includes('sku') || rowStr.includes('codigo') || rowStr.includes('producto') || rowStr.includes('nombre')) {
        headerRow = i;
        break;
      }
    }

    const headers = (rawData[headerRow] || []).map(h =>
      String(h || '').toLowerCase().trim()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, '_')
    );

    const colMap = {
      sku: headers.findIndex(h => h.includes('sku') || h.includes('codigo') || h.includes('code')),
      name: headers.findIndex(h => h.includes('nombre') || h.includes('producto') || h.includes('name') || h.includes('descripcion')),
      category: headers.findIndex(h => h.includes('categoria') || h.includes('category') || h.includes('linea')),
      basePrice: headers.findIndex(h => h.includes('precio') || h.includes('price') || h.includes('costo'))
    };

    const productsData = [];
    for (let i = headerRow + 1; i < rawData.length; i++) {
      const row = rawData[i];
      if (!row || row.length === 0) continue;

      const getValue = (idx) => idx >= 0 && row[idx] ? String(row[idx]).trim() : '';
      const getNumber = (idx) => {
        if (idx < 0 || !row[idx]) return null;
        const val = parseFloat(String(row[idx]).replace(/[^0-9.-]/g, ''));
        return isNaN(val) ? null : val;
      };

      const sku = getValue(colMap.sku);
      if (!sku) continue;

      productsData.push({
        sku: sku,
        name: getValue(colMap.name) || `Producto ${sku}`,
        category: getValue(colMap.category) || 'General',
        base_price: getNumber(colMap.basePrice)
      });
    }

    const results = await intelligenceService.upsertProducts(productsData);

    res.json({
      success: true,
      message: `Importación completada`,
      data: {
        sheet: sheetName,
        totalRows: productsData.length,
        ...results
      }
    });

  } catch (error) {
    console.error('Error uploading products:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// MÓDULO 1: RUTAS Y FLOTA
// =============================================

app.post('/routes/start', async (req, res) => {
  try {
    const { userId, vehicleId, startKm } = req.body;
    const result = await routesService.startDay({ userId, vehicleId, startKm });
    res.status(201).json({
      success: true,
      message: 'Día iniciado correctamente',
      data: result
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.post('/routes/checkin', async (req, res) => {
  try {
    const { routeId, clientId, outcome, audioUrl, lat, lng, addressUpdate, checklistData } = req.body;
    const result = await routesService.checkIn({ routeId, clientId, outcome, audioUrl, lat, lng, addressUpdate, checklistData });
    res.status(201).json({
      success: true,
      message: result.addressUpdated ? 'Visita registrada y dirección actualizada' : 'Visita registrada correctamente',
      data: result
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.get('/routes/active/:userId', async (req, res) => {
  try {
    const route = await routesService.getActiveRoute(req.params.userId);
    if (!route) {
      return res.status(404).json({ success: false, error: 'No hay ruta activa para hoy' });
    }
    res.json({ success: true, data: route });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/routes/checkout', async (req, res) => {
  try {
    const { visitId, lat, lng } = req.body;
    if (!visitId) return res.status(400).json({ success: false, error: 'Se requiere visitId' });
    const result = await routesService.checkOut({ visitId, lat, lng });
    res.json({
      success: true,
      message: `Check-out registrado (${result.durationMin} min)`,
      data: result
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.post('/routes/:routeId/end', async (req, res) => {
  try {
    const { endKm, tollCost } = req.body;
    const result = await routesService.endDay(req.params.routeId, endKm, tollCost);
    res.json({
      success: true,
      message: 'Día finalizado correctamente',
      data: result
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Obtener zonas disponibles para un vendedor
app.get('/routes/zones/:userId', async (req, res) => {
  try {
    const zones = await routesService.getVendorZones(req.params.userId);
    res.json({ success: true, data: zones });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Obtener ruta optimizada para un vendedor (filtrada por zona)
app.get('/routes/optimize/:userId', async (req, res) => {
  try {
    const { zone, startLat, startLng, exclude, shuffle } = req.query;
    let startPoint = null;
    if (startLat && startLng) {
      startPoint = { lat: parseFloat(startLat), lng: parseFloat(startLng) };
    }
    const excludeIds = exclude ? exclude.split(',').filter(Boolean) : [];
    const options = { shuffle: shuffle === 'true' };
    const result = await routesService.getOptimizedRoute(req.params.userId, zone, startPoint, excludeIds, options);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Recalcular ruta activa desde ubicación actual
app.post('/routes/recalculate', async (req, res) => {
  try {
    const { userId, lat, lng } = req.body;
    if (!userId || !lat || !lng) return res.status(400).json({ success: false, error: 'Se requiere userId, lat, lng' });
    const result = await routesService.recalculateActiveRoute(userId, parseFloat(lat), parseFloat(lng));
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Obtener configuración de vehículo estándar
app.get('/routes/vehicle-config', (req, res) => {
  res.json({ success: true, data: routesService.getVehicleConfig() });
});

// =============================================
// AUDIT LOG
// =============================================

app.get('/api/audit', authorize('admin', 'supervisor'), async (req, res) => {
  try {
    const { entity_type, entity_id, user_id, limit, offset } = req.query;
    const data = await routesService.getAuditLog({
      entityType: entity_type,
      entityId: entity_id,
      userId: user_id,
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0
    });
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// MÓDULO 2: INTELIGENCIA DE MERCADO
// =============================================

// =============================================
// WEBHOOKS N8N - ENTRADA (n8n → LEKER)
// =============================================

// Webhook: Actualización de precios (scraping)
app.post('/webhooks/n8n-price-update', webhookAuth, async (req, res) => {
  try {
    const { prices, productSku, competitorName, detectedPrice, source, evidenceUrl } = req.body;
    const priceData = prices || { productSku, competitorName, detectedPrice, source, evidenceUrl };
    const results = await intelligenceService.processPriceUpdate(priceData);

    const hasErrors = results.errors.length > 0;
    res.status(hasErrors ? 207 : 200).json({
      success: !hasErrors || results.inserted.length > 0,
      message: `Procesados: ${results.inserted.length}, Errores: ${results.errors.length}`,
      data: results
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Webhook: Sincronización de clientes desde ERP/CRM
app.post('/webhooks/n8n-sync-clients', webhookAuth, async (req, res) => {
  try {
    const { clients, mode = 'upsert' } = req.body;

    if (!clients || !Array.isArray(clients)) {
      return res.status(400).json({ success: false, error: 'Se requiere un array de clientes' });
    }

    // Map fields from external format
    const mappedClients = clients.map(c => ({
      external_id: c.codigo || c.external_id || c.id,
      name: c.razon_social || c.name || c.nombre,
      fantasy_name: c.nombre_fantasia || c.fantasy_name,
      address: c.direccion || c.address,
      commune: c.comuna || c.commune,
      zone: c.zona || c.zone,
      segment: c.segmento || c.segment || 'C',
      priority: c.prioridad || c.priority || 'Normal',
      lat: c.latitud || c.lat,
      lng: c.longitud || c.lng
    }));

    const results = mode === 'replace'
      ? await routesService.replaceClients(mappedClients)
      : await routesService.upsertClients(mappedClients);

    // Trigger outbound webhook
    await triggerWebhook('sync_completed', { type: 'clients', count: mappedClients.length, results });

    res.json({
      success: true,
      message: `Sincronización completada: ${results.inserted} procesados`,
      data: results
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Webhook: Sincronización de productos
app.post('/webhooks/n8n-sync-products', webhookAuth, async (req, res) => {
  try {
    const { products, mode = 'upsert' } = req.body;

    if (!products || !Array.isArray(products)) {
      return res.status(400).json({ success: false, error: 'Se requiere un array de productos' });
    }

    const results = await intelligenceService.upsertProducts(products);

    await triggerWebhook('sync_completed', { type: 'products', count: products.length, results });

    res.json({
      success: true,
      message: `Productos sincronizados: ${results.inserted}`,
      data: results
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Webhook: Sincronización de ejecutivos
app.post('/webhooks/n8n-sync-users', webhookAuth, async (req, res) => {
  try {
    const { users, mode = 'upsert' } = req.body;

    if (!users || !Array.isArray(users)) {
      return res.status(400).json({ success: false, error: 'Se requiere un array de usuarios' });
    }

    const mappedUsers = users.map(u => ({
      full_name: u.nombre || u.full_name || u.name,
      email: u.email || u.correo,
      role: u.rol || u.role || 'executive'
    }));

    const results = mode === 'replace'
      ? await routesService.replaceUsers(mappedUsers)
      : await routesService.upsertUsers(mappedUsers);

    res.json({
      success: true,
      message: `Usuarios sincronizados: ${results.inserted}`,
      data: results
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Webhook: Comparativo de competencia desde n8n (LEKER v32 - STOCKS FIX)
app.post('/webhooks/n8n-comparativo', webhookAuth, async (req, res) => {
  try {
    const { items, data, productos, comparativo } = req.body;

    // Aceptar diferentes formatos del payload
    const records = items || data || productos || comparativo || (Array.isArray(req.body) ? req.body : [req.body]);

    if (!records || (Array.isArray(records) && records.length === 0)) {
      return res.status(400).json({
        success: false,
        error: 'No se recibieron datos del comparativo',
        received: Object.keys(req.body)
      });
    }

    const itemsArray = Array.isArray(records) ? records : [records];

    console.log(`[Comparativo] Recibidos ${itemsArray.length} productos desde n8n`);

    const results = await intelligenceService.saveCompetitorComparison(itemsArray);

    // Generar resumen semanal si es lunes
    const today = new Date();
    if (today.getDay() === 1) {
      await intelligenceService.saveWeeklySummary();
    }

    res.json({
      success: true,
      message: `Comparativo procesado: ${results.inserted} productos guardados`,
      data: {
        received: itemsArray.length,
        inserted: results.inserted,
        errors: results.errors.length,
        errorDetails: results.errors.slice(0, 5) // Solo primeros 5 errores
      }
    });
  } catch (error) {
    console.error('[Comparativo] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// WEBHOOKS N8N - SALIDA (LEKER → n8n)
// =============================================

// In-memory webhook configuration (en producción usar base de datos)
let webhookConfig = {
  enabled: false,
  url: '',
  secret: '',
  events: ['route_completed', 'visit_registered', 'goal_reached', 'price_alert', 'sync_completed']
};

// Configurar webhook de salida
app.post('/api/webhooks/config', authorize('admin'), async (req, res) => {
  try {
    const { url, secret, events, enabled } = req.body;

    if (url) webhookConfig.url = url;
    if (secret) webhookConfig.secret = secret;
    if (events) webhookConfig.events = events;
    if (typeof enabled === 'boolean') webhookConfig.enabled = enabled;

    res.json({
      success: true,
      message: 'Configuración de webhook actualizada',
      data: { ...webhookConfig, secret: webhookConfig.secret ? '****' : '' }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Obtener configuración de webhook
app.get('/api/webhooks/config', (req, res) => {
  res.json({
    success: true,
    data: { ...webhookConfig, secret: webhookConfig.secret ? '****' : '' }
  });
});

// Test webhook
app.post('/api/webhooks/test', authorize('admin'), async (req, res) => {
  try {
    if (!webhookConfig.url) {
      return res.status(400).json({ success: false, error: 'No hay URL de webhook configurada' });
    }

    const testPayload = {
      event: 'test',
      timestamp: new Date().toISOString(),
      data: { message: 'Test de conexión desde LEKER' }
    };

    const result = await triggerWebhook('test', testPayload.data);

    res.json({
      success: result.success,
      message: result.success ? 'Webhook enviado correctamente' : 'Error al enviar webhook',
      data: result
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Función para disparar webhooks
async function triggerWebhook(event, data) {
  if (!webhookConfig.enabled || !webhookConfig.url) {
    return { success: false, reason: 'Webhook no configurado' };
  }

  if (!webhookConfig.events.includes(event) && event !== 'test') {
    return { success: false, reason: 'Evento no habilitado' };
  }

  try {
    const payload = {
      event,
      timestamp: new Date().toISOString(),
      data
    };

    const headers = {
      'Content-Type': 'application/json'
    };

    if (webhookConfig.secret) {
      headers['X-Webhook-Secret'] = webhookConfig.secret;
    }

    const response = await fetch(webhookConfig.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    return {
      success: response.ok,
      status: response.status,
      event
    };
  } catch (error) {
    console.error('Webhook error:', error.message);
    return { success: false, error: error.message };
  }
}

// =============================================
// API DE REPORTES PARA N8N
// =============================================

// Reporte diario de rutas
app.get('/api/reports/daily-routes', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const routes = await routesService.getRoutesByDate(date);

    const summary = {
      date,
      total_routes: routes.length,
      completed: routes.filter(r => r.status === 'completed').length,
      active: routes.filter(r => r.status === 'active').length,
      total_visits: routes.reduce((sum, r) => sum + (r.visits_count || 0), 0),
      total_km: routes.reduce((sum, r) => sum + ((r.end_km || 0) - (r.start_km || 0)), 0),
      routes
    };

    res.json({ success: true, data: summary });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Reporte de ejecutivos
app.get('/api/reports/executives', async (req, res) => {
  try {
    const users = await routesService.getAllUsers();
    const clients = await routesService.getAllClients();
    const routes = await routesService.getAllRoutes();

    const executives = users
      .filter(u => u.role === 'executive' || u.role === 'supervisor')
      .map(exec => {
        const assignedClients = clients.filter(c => c.assigned_user_id === exec.id);
        const execRoutes = routes.filter(r => r.user_id === exec.id);
        const completedRoutes = execRoutes.filter(r => r.status === 'completed');

        return {
          id: exec.id,
          name: exec.full_name,
          email: exec.email,
          role: exec.role,
          clients_assigned: assignedClients.length,
          total_routes: execRoutes.length,
          completed_routes: completedRoutes.length,
          total_visits: completedRoutes.reduce((sum, r) => sum + (r.visits_count || 0), 0)
        };
      });

    res.json({ success: true, data: executives });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Reporte de clientes sin visita
app.get('/api/reports/clients-without-visit', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const clients = await routesService.getAllClients();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const clientsWithoutVisit = clients.filter(c => {
      if (!c.last_visit_at) return true;
      return new Date(c.last_visit_at) < cutoffDate;
    });

    res.json({
      success: true,
      data: {
        days,
        total: clientsWithoutVisit.length,
        clients: clientsWithoutVisit.map(c => ({
          id: c.id,
          external_id: c.external_id,
          name: c.name,
          fantasy_name: c.fantasy_name,
          commune: c.commune,
          segment: c.segment,
          last_visit: c.last_visit_at
        }))
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Reporte de precios y competencia
app.get('/api/reports/price-intelligence', async (req, res) => {
  try {
    const prices = await intelligenceService.getAllPrices();
    const products = await intelligenceService.getAllProducts();

    // Group prices by product
    const pricesByProduct = {};
    prices.forEach(p => {
      if (!pricesByProduct[p.product_id]) {
        pricesByProduct[p.product_id] = [];
      }
      pricesByProduct[p.product_id].push(p);
    });

    const report = products.map(product => {
      const productPrices = pricesByProduct[product.id] || [];
      const competitors = [...new Set(productPrices.map(p => p.competitor_name))];
      const avgPrice = productPrices.length > 0
        ? productPrices.reduce((sum, p) => sum + p.detected_price, 0) / productPrices.length
        : null;

      return {
        product_id: product.id,
        sku: product.sku,
        name: product.name,
        our_price: product.base_price,
        avg_competitor_price: avgPrice ? Math.round(avgPrice) : null,
        price_difference: avgPrice ? Math.round(product.base_price - avgPrice) : null,
        competitors_tracked: competitors.length,
        last_update: productPrices.length > 0
          ? productPrices.sort((a, b) => new Date(b.detected_at) - new Date(a.detected_at))[0].detected_at
          : null
      };
    });

    res.json({ success: true, data: report });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// COMPARATIVO DE COMPETENCIA
// =============================================

// Obtener comparativo actual (últimos datos por fuente)
app.get('/api/comparativo', async (req, res) => {
  try {
    const data = await intelligenceService.getLatestComparison();
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Obtener estadísticas del comparativo
app.get('/api/comparativo/stats', async (req, res) => {
  try {
    const stats = await intelligenceService.getComparisonStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Obtener histórico para gráficos
app.get('/api/comparativo/history', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const history = await intelligenceService.getComparisonHistory(days);
    res.json({ success: true, data: history });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/intelligence/product/:productId/history', async (req, res) => {
  try {
    const history = await intelligenceService.getPriceHistory(
      req.params.productId,
      req.query.days ? parseInt(req.query.days) : 30
    );
    res.json({ success: true, data: history });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/intelligence/product/:productId/comparison', async (req, res) => {
  try {
    const comparison = await intelligenceService.getPriceComparison(req.params.productId);
    res.json({ success: true, data: comparison });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// SEGMENTACIÓN DE CLIENTES
// =============================================

// Sincronizar segmentación desde datos del frontend
app.post('/api/clients/sync-segmentation', async (req, res) => {
  try {
    const { codes8020 } = req.body;
    const result = await routesService.syncClientSegmentationFromCodes([], codes8020 || []);
    res.json({
      success: true,
      message: `Segmentación sincronizada: ${result.segmentCounts['80-20']} clave (80-20), ${result.segmentCounts.L} con ventas (L)`,
      data: result
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Sincronizar direcciones desde Google Sheets → Supabase
app.post('/api/clients/sync-addresses', async (req, res) => {
  try {
    const { addresses } = req.body;
    if (!addresses || !Array.isArray(addresses) || addresses.length === 0) {
      return res.status(400).json({ success: false, error: 'Se requiere un array de addresses [{code, address, commune, city, region}]' });
    }

    let updated = 0, notFound = 0, skipped = 0, errors = [];

    for (const addr of addresses) {
      if (!addr.code) { skipped++; continue; }

      const code = String(addr.code).trim();
      if (!code) { skipped++; continue; }

      // Find client by external_id
      const { data: clients } = await supabase
        .from('clients')
        .select('id, address, commune, lat, lng')
        .eq('external_id', code)
        .limit(1);

      if (!clients || clients.length === 0) { notFound++; continue; }

      const client = clients[0];
      const updateData = {};

      // Only update if the field is empty or we have better data
      if (addr.address && (!client.address || client.address === 'Sin dirección')) {
        updateData.address = addr.address;
      }
      if (addr.commune && !client.commune) {
        updateData.commune = addr.commune;
      }
      if (addr.city) {
        updateData.city = addr.city;
      }
      if (addr.region) {
        updateData.region = addr.region;
      }

      if (Object.keys(updateData).length > 0) {
        const { error } = await supabase
          .from('clients')
          .update(updateData)
          .eq('id', client.id);

        if (error) {
          errors.push(`${code}: ${error.message}`);
        } else {
          updated++;
        }
      } else {
        skipped++;
      }
    }

    res.json({
      success: true,
      message: `Sync completado: ${updated} actualizados, ${notFound} no encontrados, ${skipped} sin cambios`,
      data: { updated, notFound, skipped, errors: errors.slice(0, 10) }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Config pública (sheets URL)
app.get('/api/config/sheets-url', (req, res) => {
  res.json({ url: process.env.GOOGLE_SHEETS_URL || null });
});

// Estadísticas de segmentación
app.get('/api/clients/segmentation-stats', async (req, res) => {
  try {
    const stats = await routesService.getSegmentationStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// CHECKLIST DE VISITA
// =============================================

// Datos consolidados para checklist de un cliente
app.get('/api/clients/:clientId/checklist-data', async (req, res) => {
  try {
    const data = await routesService.getClientChecklistData(req.params.clientId);
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Confirmar dirección de cliente (validación en terreno)
app.put('/api/clients/:clientId/confirm-address', async (req, res) => {
  try {
    const { lat, lng, address } = req.body;
    const confirmedBy = req.body.confirmedBy || req.body.userId;
    if (!confirmedBy) {
      return res.status(400).json({ success: false, error: 'Se requiere userId del confirmador' });
    }
    const data = await routesService.confirmClientAddress(req.params.clientId, { lat, lng, address }, confirmedBy);
    res.json({ success: true, message: 'Dirección confirmada', data });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Actualizar ficha del cliente
app.put('/api/clients/:clientId/profile', async (req, res) => {
  try {
    const data = await routesService.updateClientProfile(req.params.clientId, req.body);
    res.json({ success: true, message: 'Ficha del cliente actualizada', data });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// =============================================
// RUTAS PLANIFICADAS
// =============================================

// Generar plan semanal
app.post('/api/routes/generate-schedule', async (req, res) => {
  try {
    const { userId, startDate, endDate } = req.body;
    if (!userId || !startDate || !endDate) {
      return res.status(400).json({ success: false, error: 'Se requiere userId, startDate y endDate' });
    }
    const result = await routesService.generateSchedule(userId, startDate, endDate);
    res.json({
      success: true,
      message: `Plan generado: ${result.totalClients} clientes en ${result.days} días`,
      data: result
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Programar ruta optimizada para una fecha
app.post('/api/routes/schedule-optimized', async (req, res) => {
  try {
    const { userId, date, clients } = req.body;
    if (!userId || !date || !clients || clients.length === 0) {
      return res.status(400).json({ success: false, error: 'Se requiere userId, date y clients[]' });
    }
    const result = await routesService.scheduleOptimizedDay(userId, date, clients);
    res.json({
      success: true,
      message: `Ruta programada: ${result.scheduled} clientes para ${date}`,
      data: result
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Programar ruta optimizada multi-día (acumulativo)
app.post('/api/routes/schedule-optimized-multi', async (req, res) => {
  try {
    const { userId, days } = req.body;
    if (!userId || !days || Object.keys(days).length === 0) {
      return res.status(400).json({ success: false, error: `Se requiere userId y days. Recibido: userId=${userId}, days keys=${days ? Object.keys(days).join(',') : 'null'}` });
    }
    const result = await routesService.scheduleOptimizedMultiDay(userId, days);
    res.json({
      success: true,
      message: `Ruta programada: ${result.scheduled} clientes en ${result.days} días`,
      data: result
    });
  } catch (error) {
    console.error('Error schedule-optimized-multi:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// Eliminar todas las rutas pendientes de un día
app.delete('/api/routes/schedule/:userId/:date', async (req, res) => {
  try {
    const { userId, date } = req.params;
    if (!userId || !date) {
      return res.status(400).json({ success: false, error: 'Se requiere userId y date' });
    }
    const result = await routesService.deleteScheduledDay(userId, date);
    res.json({ success: true, message: `${result.deleted} rutas eliminadas`, data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Eliminar una ruta programada individual
app.delete('/api/routes/schedule-route/:routeId', async (req, res) => {
  try {
    const result = await routesService.deleteScheduledRoute(req.params.routeId);
    res.json({ success: true, message: 'Ruta eliminada', data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Eliminar ruta diaria (daily_route)
app.delete('/api/routes/daily/:routeId', async (req, res) => {
  try {
    const { error } = await supabase
      .from('daily_routes')
      .delete()
      .eq('id', req.params.routeId);
    if (error) throw error;
    res.json({ success: true, message: 'Ruta eliminada' });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Reprogramar rutas pendientes
app.post('/api/routes/reschedule-incomplete', async (req, res) => {
  try {
    const { userId, date } = req.body;
    if (!userId || !date) {
      return res.status(400).json({ success: false, error: 'Se requiere userId y date' });
    }
    const result = await routesService.rescheduleIncomplete(userId, date);
    res.json({ success: true, message: `${result.rescheduled} rutas reprogramadas`, data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Mover todas las rutas de un día a otro
app.post('/api/routes/move-day', async (req, res) => {
  try {
    const { userId, fromDate, toDate } = req.body;
    if (!userId || !fromDate || !toDate) {
      return res.status(400).json({ success: false, error: 'Se requiere userId, fromDate y toDate' });
    }
    const result = await routesService.moveScheduledDay(userId, fromDate, toDate);
    res.json({ success: true, message: `${result.moved} rutas movidas`, data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Obtener TODAS las rutas planificadas (calendario mensual multi-ejecutivo)
app.get('/api/routes/schedule-all', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, error: 'Se requiere startDate y endDate' });
    }
    const data = await routesService.getAllScheduledRoutes(startDate, endDate);
    return res.json({ success: true, data });
  } catch (error) {
    console.error('[schedule-all] Error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Error interno' });
  }
});

// Obtener rutas programadas de HOY para todos los vendedores (panel de Visitas)
app.get('/api/routes/today-scheduled', async (req, res) => {
  try {
    const data = await routesService.getTodayScheduledRoutes();
    res.json({ success: true, data });
  } catch (error) {
    console.error('[today-scheduled] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Obtener rutas planificadas de un vendedor
app.get('/api/routes/schedule/:userId', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const data = await routesService.getScheduledRoutes(req.params.userId, startDate, endDate);
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Modificar ruta planificada (ejecutivo: skip/reschedule)
app.put('/api/routes/schedule/:routeId', async (req, res) => {
  try {
    const { action, reason, newDate } = req.body;
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'No autenticado' });
    if (!action) return res.status(400).json({ success: false, error: 'Se requiere action (skip|reschedule)' });

    const result = await routesService.modifyScheduledRoute(req.params.routeId, userId, { action, reason, newDate });
    res.json({ success: true, message: `Ruta ${action === 'skip' ? 'saltada' : 'reagendada'}`, data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Obtener alertas de ruta (admin)
app.get('/api/routes/alerts', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.json({ success: true, data: [] });
    const unreadOnly = req.query.unread === 'true';
    const data = await routesService.getRouteAlerts(userId, unreadOnly);
    res.json({ success: true, data });
  } catch (error) {
    // Graceful: return empty on any error (table may not exist)
    res.json({ success: true, data: [] });
  }
});

// Contar alertas no leídas
app.get('/api/routes/alerts/count', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.json({ success: true, count: 0 });
    const count = await routesService.getUnreadAlertCount(userId);
    res.json({ success: true, count });
  } catch (error) {
    res.json({ success: true, count: 0 });
  }
});

// Marcar alerta como leída
app.put('/api/routes/alerts/:id/read', async (req, res) => {
  try {
    await routesService.markAlertRead(req.params.id);
    res.json({ success: true, message: 'Alerta marcada como leída' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Marcar todas las alertas como leídas
app.put('/api/routes/alerts/read-all', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'No autenticado' });
    await routesService.markAllAlertsRead(userId);
    res.json({ success: true, message: 'Todas las alertas marcadas como leídas' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Auto-reprogramar rutas pendientes del día
app.post('/api/routes/auto-reschedule', authorize('admin'), async (req, res) => {
  try {
    const result = await routesService.autoRescheduleEndOfDay();
    res.json({ success: true, message: `${result.rescheduled} rutas reprogramadas`, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Recalcular frecuencias de visita
app.post('/api/clients/update-visit-frequency', async (req, res) => {
  try {
    const result = await routesService.updateAllVisitFrequencies();
    res.json({ success: true, message: `${result.updated} frecuencias actualizadas`, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// DASHBOARD MEJORADO
// =============================================

// Ventas por vendedor desde Google Sheets para un mes dado
app.get('/api/dashboard/vendor-sales', authorize('admin', 'supervisor', 'zonal'), async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const [year, monthNum] = month.split('-');
  if (!googleSheetsService.isConfigured()) {
    return res.json({ success: true, data: {}, configured: false });
  }
  try {
    const rows = await googleSheetsService.getSheet('Ventas por Mes Clientes');
    const parseNum = s => parseFloat(String(s || '').replace(/\./g, '').replace(',', '.')) || 0;
    const normV = n => String(n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
    const sales = {};
    const clientSets = {};
    for (const row of rows.slice(2)) {
      if (!row || row.length < 9) continue;
      const vendedor = (row[6] || '').trim();
      const mes = String(row[7] || '').trim();
      const anio = String(row[8] || '').trim();
      const total = parseNum(row[5]);
      const cod = (row[0] || '').trim();
      if (mes !== String(parseInt(monthNum)) || anio !== year || total === 0) continue;
      const key = normV(vendedor);
      if (!sales[key]) { sales[key] = { total: 0, raw: vendedor }; clientSets[key] = new Set(); }
      sales[key].total += total;
      if (cod) clientSets[key].add(cod);
    }
    const data = {};
    for (const [k, v] of Object.entries(sales)) {
      data[k] = { total: v.total, raw: v.raw, clientsWithSale: clientSets[k].size };
    }
    res.json({ success: true, data, month });
  } catch (e) {
    res.json({ success: false, error: e.message, data: {} });
  }
});

// Estadísticas por vendedor
app.get('/api/dashboard/vendor-stats', async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const data = await routesService.getVendorDashboardStats(month);
    res.json({ success: true, data, month });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Calendario de visitas de un vendedor
app.get('/api/dashboard/calendar/:userId', async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const data = await routesService.getVendorCalendar(req.params.userId, month);
    res.json({ success: true, data, month });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    mode: 'PRODUCTION',
    database: 'Supabase',
    n8n: n8nService.isConfigured() ? 'configured' : 'not_configured',
    timestamp: new Date().toISOString()
  });
});

// =============================================
// INTEGRACIÓN N8N - API
// =============================================

// Test conexión con n8n
app.get('/api/n8n/test', authorize('admin'), async (req, res) => {
  try {
    const result = await n8nService.testConnection();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Configurar n8n (actualiza URL y API key en runtime)
app.post('/api/n8n/config', authorize('admin'), async (req, res) => {
  try {
    const { apiUrl, apiKey } = req.body;
    n8nService.updateConfig(apiUrl, apiKey);

    // Test connection with new config
    const testResult = await n8nService.testConnection();

    res.json({
      success: testResult.success,
      message: testResult.success ? 'Configuración actualizada y conexión verificada' : 'Configuración actualizada pero la conexión falló',
      connectionTest: testResult
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Obtener estado de configuración
app.get('/api/n8n/status', authorize('admin'), (req, res) => {
  res.json({
    success: true,
    configured: n8nService.isConfigured(),
    apiUrl: n8nService.apiUrl ? n8nService.apiUrl.replace(/\/api\/v1$/, '') : null
  });
});

// Listar workflows
app.get('/api/n8n/workflows', authorize('admin'), async (req, res) => {
  try {
    const workflows = await n8nService.listWorkflows();
    res.json({ success: true, data: workflows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Obtener workflow específico
app.get('/api/n8n/workflows/:id', authorize('admin'), async (req, res) => {
  try {
    const workflow = await n8nService.getWorkflow(req.params.id);
    res.json({ success: true, data: workflow });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Activar workflow
app.post('/api/n8n/workflows/:id/activate', authorize('admin'), async (req, res) => {
  try {
    const result = await n8nService.activateWorkflow(req.params.id);
    res.json({ success: true, message: 'Workflow activado', data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Desactivar workflow
app.post('/api/n8n/workflows/:id/deactivate', authorize('admin'), async (req, res) => {
  try {
    const result = await n8nService.deactivateWorkflow(req.params.id);
    res.json({ success: true, message: 'Workflow desactivado', data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Ejecutar workflow manualmente
app.post('/api/n8n/workflows/:id/execute', authorize('admin'), async (req, res) => {
  try {
    const result = await n8nService.executeWorkflow(req.params.id, req.body);
    res.json({ success: true, message: 'Workflow ejecutado', data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Listar ejecuciones
app.get('/api/n8n/executions', authorize('admin'), async (req, res) => {
  try {
    const { workflowId, limit } = req.query;
    const executions = await n8nService.listExecutions(workflowId, parseInt(limit) || 20);
    res.json({ success: true, data: executions });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Obtener plantillas de workflows
app.get('/api/n8n/templates', authorize('admin'), (req, res) => {
  const templates = n8nService.getWorkflowTemplates();
  res.json({ success: true, data: templates });
});

// Crear workflow desde plantilla
app.post('/api/n8n/workflows/from-template', authorize('admin'), async (req, res) => {
  try {
    const { templateId } = req.body;
    const templates = n8nService.getWorkflowTemplates();

    if (!templates[templateId]) {
      return res.status(400).json({ success: false, error: 'Plantilla no encontrada' });
    }

    const result = await n8nService.createWorkflowFromTemplate(templates[templateId]);
    res.json({ success: true, message: 'Workflow creado', data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// API ENDPOINTS - VISIT PERFORMANCE
// =============================================

app.get('/api/visit-performance', async (req, res) => {
  try {
    const { from, to } = req.query;
    const data = await routesService.getVisitPerformance(from || null, to || null);
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// SYNC VENDEDORES FROM GOOGLE SHEETS
// =============================================

app.post('/api/sync-vendedores', async (req, res) => {
  try {
    if (!googleSheetsService.isConfigured()) {
      return res.status(400).json({ success: false, error: 'Google Sheets no configurado' });
    }
    const allSheets = await googleSheetsService.getAllSheets();
    // Find vendedores sheet
    const sheetKey = Object.keys(allSheets).find(k => k.toLowerCase().includes('vendedor'));
    if (!sheetKey) {
      return res.status(404).json({ success: false, error: 'Hoja de vendedores no encontrada' });
    }
    const rows = allSheets[sheetKey];
    // Find header row
    let headerIdx = 0;
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      if (rows[i].some(c => c && String(c).toLowerCase().includes('vendedor'))) { headerIdx = i; break; }
    }
    const headers = rows[headerIdx];
    const nameIdx = headers.findIndex(h => h && String(h).toLowerCase().includes('vendedor'));
    const zonaIdx = headers.findIndex(h => h && String(h).toLowerCase().includes('zona'));
    const zonalIdx = headers.findIndex(h => h && String(h).toLowerCase().includes('zonal'));

    // Get all users
    const users = await routesService.getAllUsers();
    let updated = 0;
    const results = [];

    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      const name = (nameIdx >= 0 ? row[nameIdx] : '');
      const isZonal = row[0] && String(row[0]).toLowerCase().includes('zonal');
      if (!name) continue;

      // Match user by full_name (case insensitive)
      const user = users.find(u => u.full_name && u.full_name.toLowerCase() === name.toLowerCase());
      if (user && isZonal && user.role !== 'zonal') {
        // Update role to zonal
        try {
          await routesService.updateUser(user.id, { role: 'zonal' });
          updated++;
          results.push({ name: user.full_name, action: 'role updated to zonal' });
        } catch (e) {
          results.push({ name: user.full_name, action: 'error: ' + e.message });
        }
      }
    }

    res.json({ success: true, message: `${updated} usuarios actualizados`, data: results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// API ENDPOINTS - GOOGLE SHEETS
// =============================================

app.get('/api/gsheets/status', (req, res) => {
  res.json({
    success: true,
    configured: googleSheetsService.isConfigured(),
    spreadsheetId: googleSheetsService.isConfigured() ? process.env.GOOGLE_SHEETS_SPREADSHEET_ID : null,
    clientTab: process.env.GOOGLE_SHEETS_CLIENT_TAB || 'Direccion'
  });
});

app.get('/api/gsheets/all', async (req, res) => {
  // Retry up to 2 times on timeout/network errors
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const data = await googleSheetsService.getAllSheets();
      return res.json({ success: true, data });
    } catch (error) {
      console.error(`[GSheets] Intento ${attempt} falló:`, error.message);
      if (attempt >= 2 || !error.message.includes('ETIMEDOUT')) {
        return res.status(500).json({ success: false, error: error.message });
      }
      // Wait 2s before retry
      await new Promise(r => setTimeout(r, 2000));
    }
  }
});

// Rutas específicas ANTES de /:sheet para evitar conflictos
app.get('/api/gsheets/last-push', (req, res) => {
  res.json({ success: true, lastPushAt: global._lastSheetPushAt || 0 });
});

app.get('/api/gsheets/:sheet', async (req, res) => {
  try {
    const data = await googleSheetsService.getSheet(req.params.sheet);
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Actualiza la línea de crédito de un cliente en el Google Sheet
app.post('/api/gsheets/linea-credito', authenticate, async (req, res) => {
  try {
    const { externalId, sheetName, value } = req.body;
    if (!externalId || value === undefined || value === null || isNaN(Number(value)) || Number(value) <= 0) {
      return res.status(400).json({ success: false, error: 'externalId y value (número positivo) requeridos' });
    }
    const sheet = sheetName || 'Cobranzas';
    const result = await googleSheetsService.updateSheetCell(
      sheet, String(externalId).trim(),
      ['linea', 'limite', 'credito'],
      Number(value)
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// WEBHOOK: Google Apps Script → Backend (push instantáneo)
// =============================================
global._lastSheetPushAt = global._lastSheetPushAt || 0; // timestamp del último push recibido (global para Vercel serverless)

// Apps Script llama a este endpoint cuando edita la hoja Direcciones
app.post('/api/gsheets/push', async (req, res) => {
  try {
    const { rows, secret } = req.body;
    // Verificar token simple
    if (!process.env.SHEETS_WEBHOOK_SECRET || secret !== process.env.SHEETS_WEBHOOK_SECRET) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ success: false, error: 'No rows' });
    }

    // Importar las filas recibidas directamente a la DB
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    let created = 0, updated = 0;
    for (const row of rows) {
      if (!row.external_id) continue;
      const { data: existing } = await supabase.from('clients').select('id').eq('external_id', row.external_id).single();
      const payload = {};
      if (row.name)         payload.name         = row.name;
      if (row.fantasy_name) payload.fantasy_name = row.fantasy_name;
      if (row.address)      payload.address      = row.address;
      if (row.commune)      payload.commune      = row.commune;
      if (row.city)         payload.city         = row.city;
      if (row.region)       payload.region       = row.region;
      if (row.geo_link)     payload.geo_link     = row.geo_link;
      if (existing) {
        await supabase.from('clients').update(payload).eq('external_id', row.external_id);
        updated++;
      } else {
        payload.external_id = row.external_id;
        await supabase.from('clients').insert(payload);
        created++;
      }
    }
    global._lastSheetPushAt = Date.now();
    console.log(`[GSheets Push] +${created} nuevos, ~${updated} actualizados`);
    res.json({ success: true, created, updated });
  } catch (error) {
    console.error('[GSheets Push] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Sync address(es) to Google Sheet (admin only)
app.post('/api/clients/sync-to-sheet', authorize('admin'), async (req, res) => {
  try {
    const { clientId, updates } = req.body;
    const userEmail = req.user ? req.user.email : 'admin';

    if (updates && Array.isArray(updates)) {
      // Batch mode: [{code, address, commune}]
      const result = await googleSheetsService.postToSheet({
        action: 'updateAddress',
        rows: updates.map(u => ({
          code: u.code,
          address: u.address || '',
          commune: u.commune || '',
          updatedBy: userEmail,
          updatedAt: new Date().toISOString()
        }))
      });
      return res.json({ success: true, data: result });
    }

    if (clientId) {
      // Single client mode
      const { data: client, error } = await supabase
        .from('clients')
        .select('external_id, address, commune')
        .eq('id', clientId)
        .single();

      if (error || !client) {
        return res.status(404).json({ success: false, error: 'Cliente no encontrado' });
      }

      const result = await googleSheetsService.syncAddressToSheet(
        client.external_id,
        req.body.address || client.address,
        req.body.commune || client.commune,
        userEmail
      );
      return res.json({ success: true, data: result });
    }

    res.status(400).json({ success: false, error: 'Se requiere clientId o updates[]' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Save geo link(s) to Google Sheet
app.post('/api/clients/save-geo-link', authorize('admin'), async (req, res) => {
  try {
    const { code, geoLink, batch } = req.body;
    const userEmail = req.user ? req.user.email : 'admin';

    const rows = batch && Array.isArray(batch)
      ? batch.map(b => ({ code: b.code, geoLink: b.geoLink, updatedBy: userEmail, updatedAt: new Date().toISOString() }))
      : [{ code, geoLink, updatedBy: userEmail, updatedAt: new Date().toISOString() }];

    const result = await googleSheetsService.postToSheet({
      action: 'updateAddress',
      rows
    });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// AUTO-RESCHEDULE: check every 30 min, execute at 17:30
// =============================================
setInterval(async () => {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  if (h === 17 && m >= 25 && m <= 35) {
    try {
      const result = await routesService.autoRescheduleEndOfDay();
      if (result.rescheduled > 0) {
        console.log(`[Auto-reschedule] ${result.rescheduled} rutas reprogramadas de ${result.fromDate} a ${result.toDate}`);
      }
    } catch (err) {
      console.error('[Auto-reschedule] Error:', err.message);
    }
  }
}, 30 * 60 * 1000); // every 30 minutes

// =============================================
// AI — OpenAI GPT-4o
// =============================================

// Helper: llama a GPT-4o con system + user prompt
async function askOpenAI(systemPrompt, userPrompt, maxTokens = 600, _reqMeta) {
  if (!openai) throw new Error('OPENAI_API_KEY no configurada');
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    max_tokens: maxTokens,
    temperature: 0.4
  });
  if (_reqMeta) _trackAiUsage(_reqMeta.endpoint || 'askOpenAI', _reqMeta.userId, _reqMeta.userName, completion.usage);
  return completion.choices[0].message.content.trim();
}

/**
 * POST /api/ai/generate-route
 * Genera una ruta semanal completa usando OpenAI GPT-4o como motor de decisión.
 * Devuelve el MISMO formato que GET /routes/optimize para ser drop-in replacement.
 */
app.post('/api/ai/generate-route', authenticate, async (req, res) => {
  try {
    const { userId, zone, commune, startLat, startLng, exclude = [], model } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'userId requerido' });
    if (!openai) return res.status(400).json({ success: false, error: 'OpenAI no configurado. Agrega OPENAI_API_KEY en las variables de entorno.' });
    // Modelos permitidos; default gpt-4o-mini
    const ALLOWED_MODELS = ['gpt-4o', 'gpt-4o-mini', 'o3-mini'];
    const selectedModel = ALLOWED_MODELS.includes(model) ? model : 'gpt-4o';

    // 1. Punto de inicio del vendedor
    let startPoint = null;
    if (startLat && startLng) {
      startPoint = { lat: parseFloat(startLat), lng: parseFloat(startLng) };
    } else {
      const { data: ud } = await supabase.from('users').select('home_lat,home_lng').eq('id', userId).single();
      if (ud?.home_lat && ud?.home_lng) startPoint = { lat: parseFloat(ud.home_lat), lng: parseFloat(ud.home_lng) };
    }

    // 2. Obtener clientes asignados con coords
    let query = supabase.from('clients')
      .select('id,external_id,name,fantasy_name,address,commune,lat,lng,segmentation,zone')
      .eq('assigned_user_id', userId).not('lat','is',null).not('lng','is',null);
    if (zone && zone.trim()) query = query.eq('zone', zone);
    if (commune && commune.trim()) query = query.eq('commune', commune);
    const { data: rawClients, error } = await query;
    if (error) throw error;

    // Agregar no-asignados SOLO en las mismas comunas exactas (nunca por zona — evita traer clientes de regiones lejanas)
    let unassigned = [];
    if (rawClients && rawClients.length > 0) {
      const communes = [...new Set(rawClients.map(c => c.commune).filter(Boolean))];
      if (communes.length > 0) {
        let uq = supabase.from('clients').select('id,external_id,name,fantasy_name,address,commune,lat,lng,segmentation,zone')
          .is('assigned_user_id',null).not('lat','is',null).not('lng','is',null)
          .in('commune', communes);
        if (commune && commune.trim()) uq = uq.eq('commune', commune);
        const { data: udata } = await uq.limit(40);
        unassigned = (udata || []).map(c => ({ ...c, segmentation: c.segmentation || 'N' }));
      }
    }

    let clients = [...(rawClients || []), ...unassigned].filter(c => !exclude.includes(c.id));
    if (clients.length === 0) {
      return res.json({ success: true, data: { route: [], message: 'Sin clientes con GPS', aiGenerated: true } });
    }

    // 3. Weekdays próximos
    const startDate = new Date();
    do { startDate.setDate(startDate.getDate() + 1); } while ([0,6].includes(startDate.getDay()));
    const neededDays = Math.ceil(clients.length / 8) + 2;
    const weekdays = [];
    const cursor = new Date(startDate);
    while (weekdays.length < neededDays) {
      if (cursor.getDay() >= 1 && cursor.getDay() <= 5) weekdays.push(cursor.toISOString().split('T')[0]);
      cursor.setDate(cursor.getDate() + 1);
    }

    // 4. Construir clusters geográficos por comuna (agrupación FORZADA)
    // Esto evita que la IA mezcle clientes de distintas zonas en el mismo día
    const cgMap = {};
    clients.forEach(c => {
      const k = c.commune || 'Sin Comuna';
      if (!cgMap[k]) cgMap[k] = { lat:0, lng:0, n:0, c8020:[], cL:[], cN:[] };
      cgMap[k].lat += parseFloat(c.lat); cgMap[k].lng += parseFloat(c.lng); cgMap[k].n++;
      const seg = c.segmentation || 'L';
      if (seg === '80-20') cgMap[k].c8020.push(c.id);
      else if (seg === 'N') cgMap[k].cN.push(c.id);
      else cgMap[k].cL.push(c.id);
    });
    // Clusters como lista estructurada para el prompt
    const clusters = Object.entries(cgMap).map(([comm, v]) => ({
      commune: comm,
      total: v.n,
      center: `(${(v.lat/v.n).toFixed(3)},${(v.lng/v.n).toFixed(3)})`,
      ids_8020: v.c8020,
      ids_L: v.cL.slice(0, 15), // max 15 L por comuna para no explotar tokens
      ids_N: v.cN.slice(0, 5)
    })).sort((a,b) => b.ids_8020.length - a.ids_8020.length); // primero las comunas con más 80-20

    // 5. Llamar al modelo seleccionado
    const isO3 = selectedModel === 'o3-mini';
    const completionParams = {
      model: selectedModel,
      max_tokens: 4000,
      messages: null
    };
    if (!isO3) {
      completionParams.response_format = { type: 'json_object' };
      completionParams.temperature = 0.2;
    }

    const systemPrompt = `Eres un optimizador de rutas de ventas para Leker (Chile).
REGLAS ESTRICTAS:
- Jornada 09:00-17:00 (480 min), velocidad 40 km/h, 35 min/visita
- MÁXIMO 10 clientes por día (ideal 7-8). Si una comuna tiene más de 10, distribuye en días consecutivos.
- CRÍTICO: NO mezcles clientes de comunas geográficamente lejanas en el mismo día. Cada día debe ser UNA zona geográfica compacta.
- PRIORIDAD por día: incluir TODOS los 80-20 de la comuna, luego completar con L del mismo lugar hasta llegar a 8.
- Si una comuna tiene <4 clientes, combínala con la comuna más CERCANA geográficamente (misma lat/lng aproximada).
- Ignora los clientes N salvo que no haya más 80-20 ni L disponibles.
Responde SOLO con JSON válido.`;

    const userPrompt = `Días disponibles: ${weekdays.slice(0,10).join(', ')}
Punto de inicio vendedor: ${startPoint ? `(${startPoint.lat.toFixed(3)},${startPoint.lng.toFixed(3)})` : 'desconocido'}

CLUSTERS GEOGRÁFICOS (agrupa por commune, no mezcles):
${JSON.stringify(clusters)}

REGLA: Asigna IDs de ids_8020 primero, luego ids_L para completar el día. Máx 10/día. No uses IDs de communes distintas el mismo día salvo que sean geográficamente contiguas.

Responde exactamente con este JSON:
{"days":{"YYYY-MM-DD":["uuid1","uuid2",...],...},"strategy":"breve descripción de la estrategia"}

Solo usa fechas de los días disponibles. UUIDs exactos de las listas ids_8020/ids_L/ids_N. Max 10/día.`;

    const completion = await openai.chat.completions.create({
      ...completionParams,
      messages: isO3
        ? [{ role: 'user', content: systemPrompt + '\n\n' + userPrompt }]
        : [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }]
    });

    // o3-mini puede devolver JSON dentro de texto — extraer con regex si es necesario
    let rawContent = completion.choices[0].message.content;
    if (isO3) {
      const match = rawContent.match(/\{[\s\S]*\}/);
      if (match) rawContent = match[0];
    }
    const aiResp = JSON.parse(rawContent);
    const aiDays = aiResp.days || {};
    const aiStrategy = aiResp.strategy || '';

    // 7. Mapear IDs → objetos y calcular timeline por día
    const byId = {};
    clients.forEach(c => { byId[String(c.id)] = c; });

    const daysResult = {};
    let totalClients = 0, totalDistKm = 0, totalMin = 0;

    for (const [date, ids] of Object.entries(aiDays)) {
      if (!weekdays.includes(date) || !Array.isArray(ids) || ids.length === 0) continue;
      const dayClients = ids.map(id => byId[String(id)]).filter(Boolean).slice(0, 10);
      if (dayClients.length === 0) continue;

      const tl = routesService.calculateDayTimeline(dayClients, '09:00', startPoint);
      const liters = tl.totalDistanceKm / 10;
      const fuelCLP = Math.round(liters * 1141);
      const communes = [...new Set(dayClients.map(c => c.commune||'Sin Comuna'))];

      daysResult[date] = {
        route: tl.timeline.map((t,i) => ({ order:i+1, ...t.client, estimatedArrival:t.estimatedArrival, estimatedDeparture:t.estimatedDeparture, travelTimeMin:t.travelTimeMin, travelDistKm:t.travelDistKm })),
        stats: {
          totalClients: dayClients.length,
          distanceKm: Math.round(tl.totalDistanceKm*10)/10,
          estimatedTime: Math.round(tl.totalHours*60),
          totalHours: tl.totalHours,
          endTime: tl.endTime,
          litersUsed: Math.round(liters*100)/100,
          costCLP: fuelCLP,
          costFormatted: `$${fuelCLP.toLocaleString('es-CL')}`
        },
        communes
      };
      totalClients += dayClients.length;
      totalDistKm += tl.totalDistanceKm;
      totalMin += Math.round(tl.totalHours*60);
    }

    const sortedDates = Object.keys(daysResult).sort();
    const allRoute = [];
    sortedDates.forEach(d => allRoute.push(...daysResult[d].route));
    allRoute.forEach((c,i) => { c.order = i+1; });

    const totalFuelL = totalDistKm/10;
    const totalFuelCLP = Math.round(totalFuelL*1141);

    res.json({ success: true, data: {
      route: allRoute,
      days: daysResult,
      totalStats: {
        totalClients, totalDays: sortedDates.length,
        distanceKm: Math.round(totalDistKm*10)/10,
        estimatedTime: totalMin,
        litersUsed: Math.round(totalFuelL*100)/100,
        costCLP: totalFuelCLP,
        costFormatted: `$${totalFuelCLP.toLocaleString('es-CL')}`
      },
      stats: daysResult[sortedDates[0]]?.stats || null,
      zone: zone || null,
      aiGenerated: true,
      aiModel: selectedModel,
      aiStrategy,
      tokensUsed: completion.usage?.total_tokens || 0
    }});
    _trackAiUsage('generate-route', req.user?.id, req.user?.full_name, completion.usage);

  } catch (error) {
    console.error('[AI generate-route]', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ai/route-advisor
 * Recibe lista de clientes del vendedor y devuelve recomendación de prioridad de visitas.
 * Body: { userId, clients: [{name, segmentation, lastVisit, visitCount, address, commune}], weekdays }
 */
app.post('/api/ai/route-advisor', authenticate, aiLimiter, async (req, res) => {
  try {
    const { clients, weekdays, vendorName } = req.body;
    if (!clients || clients.length === 0) {
      return res.status(400).json({ success: false, error: 'Se requieren clientes' });
    }

    const systemPrompt = `Eres un asesor de rutas de ventas para la empresa Leker (distribuidora de productos de limpieza y hogar en Chile).
Tu trabajo es analizar la lista de clientes de un vendedor y sugerir el plan de visitas óptimo para la semana.
Responde SIEMPRE en español. Sé conciso y práctico. Usa formato claro con bullets.
Considera:
- Clientes 80-20: visitar PRIMERO, máxima prioridad (generan el 80% de ventas)
- Clientes L: visitaron en 2025, mantener relación
- Clientes N: nuevos, verificar y presentar propuesta
- Jornada 09:00-17:00, máximo 10 clientes por día
- Optimizar por cercanía geográfica (misma comuna = mismo día)`;

    const clientList = clients.slice(0, 50).map((c, i) =>
      `${i+1}. ${c.name || c.fantasy_name} [${c.segmentation || 'sin seg'}] - ${c.commune || 'sin comuna'} - última visita: ${c.lastVisit || 'nunca'} - visitas totales: ${c.visitCount || 0}`
    ).join('\n');

    const userPrompt = `Vendedor: ${vendorName || 'Sin nombre'}
Semana disponible: ${(weekdays || []).join(', ') || 'próximos 5 días hábiles'}
Total clientes a visitar: ${clients.length}

Lista de clientes:
${clientList}

Por favor:
1. Indica los 3-5 clientes TOP a visitar ESTA semana con justificación breve
2. Sugiere cómo agrupar por día/zona para minimizar desplazamiento
3. Alerta si hay clientes 80-20 que llevan más de 15 días sin visita`;

    const advice = await askOpenAI(systemPrompt, userPrompt, 700);
    res.json({ success: true, advice });
  } catch (error) {
    console.error('[AI route-advisor]', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ai/visit-summary
 * Resume las visitas recientes de un vendedor y sugiere acciones.
 * Body: { visits: [{clientName, outcome, date, notes}], vendorName }
 */
app.post('/api/ai/visit-summary', authenticate, aiLimiter, async (req, res) => {
  try {
    const { visits, vendorName } = req.body;
    if (!visits || visits.length === 0) {
      return res.status(400).json({ success: false, error: 'Se requieren visitas' });
    }

    const systemPrompt = `Eres un coach de ventas para Leker (distribuidora en Chile). Analiza el historial de visitas de un vendedor y entrega un resumen ejecutivo con acciones concretas. Responde en español, máximo 5 bullets cortos.`;

    const visitList = visits.slice(0, 30).map(v =>
      `- ${v.date}: ${v.clientName} → ${v.outcome || 'sin resultado'} ${v.notes ? '('+v.notes+')' : ''}`
    ).join('\n');

    const userPrompt = `Vendedor: ${vendorName}
Últimas visitas:
${visitList}

Resume: tasa de éxito, clientes que necesitan seguimiento urgente, y 3 acciones concretas para mejorar esta semana.`;

    const summary = await askOpenAI(systemPrompt, userPrompt, 500);
    res.json({ success: true, summary });
  } catch (error) {
    console.error('[AI visit-summary]', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ai/client-insight
 * Analiza un cliente específico y da recomendación de acción.
 * Body: { client: {...}, visitHistory: [...] }
 */
app.post('/api/ai/client-insight', authenticate, aiLimiter, async (req, res) => {
  try {
    const { client, visitHistory } = req.body;
    if (!client) return res.status(400).json({ success: false, error: 'Se requiere cliente' });

    const systemPrompt = `Eres un asesor CRM para Leker. Analiza un cliente y su historial de visitas. Responde en español con máximo 3 bullets: 1) diagnóstico rápido, 2) acción recomendada, 3) frecuencia sugerida de visita.`;

    const visits = (visitHistory || []).slice(0, 10).map(v =>
      `${v.date}: ${v.outcome || 'sin resultado'}`
    ).join(', ');

    const userPrompt = `Cliente: ${client.name || client.fantasy_name}
Segmento: ${client.segmentation || 'sin segmento'}
Comuna: ${client.commune || 'desconocida'}
Visitas: ${visits || 'ninguna registrada'}
Última visita: ${visitHistory?.[0]?.date || 'nunca'}

¿Qué acción recomiendas con este cliente?`;

    const insight = await askOpenAI(systemPrompt, userPrompt, 300);
    res.json({ success: true, insight });
  } catch (error) {
    console.error('[AI client-insight]', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ai/frequency-analysis
 * Analiza clientes con baja conversión y recomienda ajustar frecuencia.
 * Body: { userId }
 */
app.post('/api/ai/frequency-analysis', authenticate, aiLimiter, async (req, res) => {
  try {
    const { userId } = req.body;

    // Obtener clientes con historial de visitas fallidas
    const { data: visits } = await supabase
      .from('visits')
      .select('client_id, outcome, visited_at, clients(name, segmentation, commune)')
      .eq('route_id', supabase.from('daily_routes').select('id').eq('user_id', userId))
      .order('visited_at', { ascending: false })
      .limit(200);

    if (!visits || visits.length === 0) {
      return res.json({ success: true, analysis: 'No hay suficiente historial de visitas para analizar.' });
    }

    // Agrupar por cliente
    const byClient = {};
    for (const v of visits) {
      const cid = v.client_id;
      if (!byClient[cid]) byClient[cid] = { name: v.clients?.name, seg: v.clients?.segmentation, commune: v.clients?.commune, visits: [] };
      byClient[cid].visits.push({ outcome: v.outcome, date: v.visited_at?.split('T')[0] });
    }

    // Clientes con 3+ visitas sin éxito
    const lowConversion = Object.values(byClient)
      .filter(c => c.visits.length >= 3 && c.visits.filter(v => v.outcome === 'no_sale' || v.outcome === 'not_home').length >= 3)
      .slice(0, 15)
      .map(c => `${c.name} [${c.seg}] ${c.commune}: ${c.visits.length} visitas, ${c.visits.filter(v=>v.outcome==='no_sale'||v.outcome==='not_home').length} sin éxito`);

    if (lowConversion.length === 0) {
      return res.json({ success: true, analysis: 'No se detectaron clientes con baja conversión repetida. ¡Buen trabajo!' });
    }

    const systemPrompt = `Eres un analista de eficiencia de rutas para Leker. Analiza clientes con baja tasa de conversión y recomienda ajustes de frecuencia o estrategia. Responde en español, formato tabla simple o bullets.`;
    const userPrompt = `Clientes con 3+ visitas sin éxito de venta:
${lowConversion.join('\n')}

Para cada uno recomienda: mantener frecuencia actual, reducir a cada 45 días, o considerar cliente inactivo. Justifica brevemente.`;

    const analysis = await askOpenAI(systemPrompt, userPrompt, 600);
    res.json({ success: true, analysis, clientsAnalyzed: lowConversion.length });
  } catch (error) {
    console.error('[AI frequency-analysis]', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── AI Company Pulse ────────────────────────────────────────────────────────
// Returns proactive platform-wide analysis: alerts, opportunities, team status
app.post('/api/ai/company-pulse', authorize('admin', 'supervisor', 'zonal'), aiLimiter, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    // 1. Today's routes
    const { data: todayRoutes } = await supabase
      .from('daily_routes')
      .select('id, user_id, status, visits_count')
      .eq('route_date', today);

    // 2. All vendors
    const { data: vendors } = await supabase
      .from('users')
      .select('id, full_name, zone')
      .in('role', ['executive', 'zonal', 'supervisor'])
      .eq('status', 'active');

    // 3. Clients without recent visit (80-20 priority, >15 days)
    const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    const { data: neglected8020 } = await supabase
      .from('clients')
      .select('id, name, fantasy_name, commune, segmentation, assigned_user_id, last_visit_at')
      .eq('segmentation', '80-20')
      .not('assigned_user_id', 'is', null)
      .or(`last_visit_at.is.null,last_visit_at.lt.${fifteenDaysAgo}`)
      .limit(30);

    // 4. GPS coverage
    const { count: totalClients } = await supabase.from('clients').select('*', { count: 'exact', head: true });
    const { count: clientsWithGPS } = await supabase.from('clients').select('*', { count: 'exact', head: true }).not('lat', 'is', null).not('lng', 'is', null);
    const clientsWithoutGPS = (totalClients || 0) - (clientsWithGPS || 0);

    // 5. Today's visits
    const routeIds = (todayRoutes || []).map(r => r.id);
    let todayVisits = [];
    if (routeIds.length > 0) {
      const { data: visits } = await supabase
        .from('visits')
        .select('id, outcome, client_id')
        .in('route_id', routeIds);
      todayVisits = visits || [];
    }

    // Build context for GPT
    const vendorMap = {};
    (vendors || []).forEach(v => { vendorMap[v.id] = v; });

    const routesByVendor = {};
    (todayRoutes || []).forEach(r => {
      routesByVendor[r.user_id] = r;
    });

    const vendorStatus = (vendors || []).map(v => {
      const route = routesByVendor[v.id];
      return `${v.full_name} [${v.zone || 'sin zona'}]: ${route ? `ruta ${route.status} (${route.visits_count || 0} visitas hoy)` : 'SIN ruta hoy'}`;
    }).join('\n');

    const neglectedList = (neglected8020 || []).slice(0, 15).map(c => {
      const vendor = vendorMap[c.assigned_user_id];
      const days = c.last_visit_at ? Math.floor((Date.now() - new Date(c.last_visit_at)) / 86400000) : 999;
      return `  - ${c.fantasy_name || c.name} (${c.commune}) → ${vendor ? vendor.full_name : 'sin vendedor'} — ${days === 999 ? 'nunca visitado' : `${days} días sin visita`}`;
    }).join('\n');

    const salesCount = todayVisits.filter(v => v.outcome === 'sale').length;
    const totalVisits = todayVisits.length;

    const userPrompt = `
Fecha: ${today}
Clientes totales: ${totalClients} | Con GPS: ${clientsWithGPS} | Sin GPS: ${clientsWithoutGPS}
Visitas hoy: ${totalVisits} (${salesCount} ventas, ${totalVisits - salesCount} sin venta)

ESTADO DEL EQUIPO HOY:
${vendorStatus || 'Sin datos'}

CLIENTES 80-20 SIN VISITA (>15 días o nunca):
${neglectedList || '  Ninguno — ¡Excelente cobertura!'}

Genera un análisis ejecutivo conciso con:
1. Estado general del equipo hoy (1 línea)
2. Máximo 3 alertas críticas (🔴 o 🟡 según urgencia)
3. Máximo 2 oportunidades detectadas (🟢)
4. Una acción prioritaria recomendada para hoy

Responde en español. Usa emojis. Máximo 10 líneas total. Sé directo y accionable.`;

    const systemPrompt = `Eres LEKER AI, el asistente inteligente de una empresa distribuidora en Chile. Analizas datos reales de la plataforma y entregas insights ejecutivos breves y accionables para que los supervisores tomen decisiones rápidas.`;

    const reply = await askOpenAI(systemPrompt, userPrompt, 500);

    res.json({
      success: true,
      pulse: reply,
      meta: {
        date: today,
        totalClients,
        clientsWithGPS,
        clientsWithoutGPS,
        vendorsActive: (todayRoutes || []).filter(r => r.status === 'active').length,
        vendorsTotal: (vendors || []).length,
        visitsToday: totalVisits,
        salesToday: salesCount,
        neglected8020: (neglected8020 || []).length
      }
    });
  } catch (error) {
    console.error('[AI Pulse] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Construye el bloque de contexto de plataforma para los endpoints de AI chat.
 * Incluye: stats, vendedores, clientes, ruta optimizada, visitas hoy,
 * rutas programadas, planner semanal, calendario mensual, panel activo.
 */
function _buildPlatformContextBlock(platformContext, routeContext) {
  let ctx = '';

  if (platformContext) {
    const { stats, vendedores, vendedorActual, rutaOptimizada, visitasHoy,
            panelActivo, subTabActivo, rutasProgramadasHoy, plannerSemanal, calendarioMensual } = platformContext;

    // Contexto de navegación — qué está mirando el usuario ahora
    if (panelActivo) {
      ctx += `\n=== USUARIO ESTÁ EN: ${panelActivo}${subTabActivo ? ` > ${subTabActivo}` : ''} ===\n`;
      ctx += `Responde en contexto de lo que el usuario está viendo. Si pregunta sobre datos visibles en su panel, responde con datos concretos.\n`;
    }

    // Stats globales
    if (stats) {
      ctx += `\n=== PLATAFORMA LEKER — ${stats.fecha} ===\n`;
      ctx += `Clientes totales: ${stats.totalClientes} | 80/20: ${stats.clientes8020} | L: ${stats.clientesL}\n`;
      ctx += `Con GPS: ${stats.clientesConGPS} | Sin GPS: ${stats.clientesSinGPS}\n`;
      ctx += `Rutas activas hoy: ${stats.rutasHoy} | Vendedores: ${stats.totalVendedores}\n`;
    }

    // Equipo de vendedores
    if (vendedores && vendedores.length > 0) {
      ctx += `\n=== VENDEDORES ===\n`;
      vendedores.forEach(v => {
        const rutaStr = v.rutaHoy ? ` | Hoy: ruta ${v.rutaHoy.estado || '?'} (${v.rutaHoy.clientesTotal || 0} clientes)` : ' | Hoy: sin ruta';
        const zonaStr = v.zona ? ` [${v.zona}]` : '';
        ctx += `• ${v.nombre}${zonaStr}: ${v.totalClientes} clientes (80/20: ${v.seg8020}, GPS: ${v.conGPS}, sin GPS: ${v.sinGPS})${rutaStr}\n`;
      });
    }

    // Clientes del vendedor seleccionado
    if (vendedorActual && vendedorActual.clientes && vendedorActual.clientes.length > 0) {
      ctx += `\n=== CLIENTES DE ${vendedorActual.nombre.toUpperCase()}${vendedorActual.zona ? ` (${vendedorActual.zona})` : ''} ===\n`;
      ctx += `Total: ${vendedorActual.clientes.length} clientes\n`;
      const byComuna = {};
      vendedorActual.clientes.forEach(c => {
        const com = c.comuna || 'Sin comuna';
        if (!byComuna[com]) byComuna[com] = [];
        byComuna[com].push(c);
      });
      Object.entries(byComuna).sort((a, b) => b[1].length - a[1].length).forEach(([com, cls]) => {
        const gpsOk = cls.filter(c => c.gps).length;
        const seg8020 = cls.filter(c => c.seg === '80-20').length;
        ctx += `  ${com}: ${cls.length} clientes (GPS: ${gpsOk}${seg8020 ? `, 80/20: ${seg8020}` : ''})\n`;
      });
      ctx += `Lista clientes (máx 80):\n`;
      vendedorActual.clientes.slice(0, 80).forEach(c => {
        ctx += `  - [${c.cod}] ${c.nombre} | ${c.comuna || '?'} | seg:${c.seg || 'L'} | GPS:${c.gps ? 'sí' : 'NO'}\n`;
      });
      if (vendedorActual.clientes.length > 80) {
        ctx += `  ... y ${vendedorActual.clientes.length - 80} clientes más\n`;
      }
    }

    // Ruta optimizada activa
    if (rutaOptimizada) {
      ctx += `\n=== RUTA OPTIMIZADA ACTUAL ===\n`;
      if (rutaOptimizada.totalStats) {
        const ts = rutaOptimizada.totalStats;
        ctx += `${ts.totalClients} clientes, ${ts.totalDays} días, ${ts.distanceKm} km, $${(ts.costCLP || 0).toLocaleString('es-CL')} combustible\n`;
      }
      if (rutaOptimizada.dias) {
        Object.entries(rutaOptimizada.dias).forEach(([fecha, dd]) => {
          const comunas = [...new Set((dd.clientes || []).map(c => c.comuna).filter(Boolean))];
          ctx += `  ${fecha}: ${dd.stats?.totalClients || 0} clientes — ${comunas.join(', ')} — ${dd.stats?.distanceKm || 0}km, termina ${dd.stats?.endTime || '?'}\n`;
        });
      }
    }

    // Visitas hoy
    if (visitasHoy && visitasHoy.length > 0) {
      ctx += `\n=== VISITAS HOY ===\n`;
      visitasHoy.forEach(v => {
        ctx += `  ${v.vendedor}: ${v.completadas} completadas, ${v.pendientes} pendientes (${v.estado || '?'})\n`;
      });
    }

    // Rutas programadas hoy (scheduled_routes)
    if (rutasProgramadasHoy && Object.keys(rutasProgramadasHoy).length > 0) {
      ctx += `\n=== RUTAS PROGRAMADAS HOY ===\n`;
      Object.entries(rutasProgramadasHoy).forEach(([vendedor, clientes]) => {
        ctx += `${vendedor}: ${clientes.length} clientes programados\n`;
        clientes.slice(0, 10).forEach(c => {
          ctx += `  - ${c.cliente} | ${c.comuna || '?'} | seg:${c.seg || 'L'}${c.hora ? ` | ${c.hora}` : ''}\n`;
        });
        if (clientes.length > 10) ctx += `  ... y ${clientes.length - 10} más\n`;
      });
    }

    // Planner semanal
    if (plannerSemanal && Object.keys(plannerSemanal).length > 0) {
      ctx += `\n=== PLANNER SEMANAL ===\n`;
      Object.entries(plannerSemanal).forEach(([vendedor, dias]) => {
        ctx += `${vendedor}:\n`;
        Object.entries(dias).forEach(([fecha, info]) => {
          ctx += `  ${fecha}: ${info.totalClientes} clientes${info.clientes8020 ? ` (${info.clientes8020} 80-20)` : ''} — ${info.clientes.slice(0, 5).join(', ')}${info.clientes.length > 5 ? '...' : ''}\n`;
        });
      });
    }

    // Calendario mensual
    if (calendarioMensual && Object.keys(calendarioMensual).length > 0) {
      ctx += `\n=== CALENDARIO MENSUAL ===\n`;
      Object.entries(calendarioMensual).forEach(([vendedor, data]) => {
        ctx += `${vendedor}: ${data.totalDias} días con rutas programadas\n`;
        data.dias.forEach(d => {
          ctx += `  ${d.fecha}: ${d.clientes} clientes${d.seg8020 ? ` (${d.seg8020} 80-20)` : ''}\n`;
        });
      });
    }

  } else if (routeContext) {
    const { vendorName, days, totalStats } = routeContext;
    ctx = `RUTA ACTUAL — ${vendorName || 'Vendedor'}:\n`;
    if (totalStats) ctx += `${totalStats.totalClients} clientes, ${totalStats.totalDays} días, ${totalStats.distanceKm} km\n`;
  }

  return ctx;
}

/**
 * Construye el system prompt compartido para AI chat.
 */
async function _buildAiSystemPrompt(contextBlock, sheetsCtx) {
  const learningsCtx = await _buildLearningsContext().catch(() => '');
  return `Eres LEKER AI, asistente inteligente de Leker (distribuidora Chile).
Tienes acceso a TODOS los datos reales del negocio: clientes, rutas, vendedores, ventas, cobranzas, 80-20.
Estás integrado en toda la plataforma — siempre sabes en qué sección está el usuario y qué datos tiene cargados.
Cuando el usuario pregunta sobre rutas programadas, planner semanal o calendario, usa los datos que tienes disponibles.
Si tienes datos del planner semanal o calendario mensual, úsalos para responder sobre rutas programadas.
NUNCA digas que no tienes información si los datos están en tu contexto.

REGLAS DE FORMATO (obligatorias):
- Nombres de vendedor SIEMPRE en mayúsculas: E.IBARRA, D.TARICCO, RUBILAR, etc.
- Montos de dinero con formato **$X.XXX.XXX** (bold + signo pesos + puntos miles)
- Porcentajes con formato **XX%**
- Para listar métricas por vendedor usa formato: Vendedor | Métrica1: valor | Métrica2: valor
- Secciones con ### Título
- Datos clave con "Etiqueta: valor" (una por línea)
- Bullets con - para listas
- Responde en español. Máx 8 líneas salvo que pidan detalle.
- NO pidas info que ya tienes.

BOTONES DE ACCIÓN (muy importante):
Cuando detectes que el usuario necesita completar una tarea o ir a una sección específica, incluye botones de acción al final de tu respuesta.
Formato: [[ir:Texto del botón|destino]]
Destinos disponibles:
- dashboard → Ir al Dashboard
- routes.gestionar → Ir a Gestionar Rutas
- routes.planner → Ir al Planner Semanal
- routes.monthly → Ir al Calendario Mensual
- crm → Ir al CRM de Clientes
- visits → Ir a Visitas
- data.vendedores → Ir a Datos > Vendedores
- data.clientes → Ir a Datos > Clientes
- gsheets.gs-ventas → Ir a Google Sheets > Ventas
- gsheets.gs-cobranzas → Ir a Google Sheets > Cobranzas
- gsheets.gs-8020 → Ir a Google Sheets > 80-20
- gsheets.gs-direcciones → Ir a Google Sheets > Direcciones
- intelligence → Ir a Inteligencia de Mercado
Ejemplos de uso:
- Si el vendedor no tiene ruta generada: [[ir:Generar ruta|routes.gestionar]]
- Si faltan visitas por completar: [[ir:Ver visitas pendientes|visits]]
- Si preguntan por ventas: [[ir:Ver ventas en detalle|gsheets.gs-ventas]]
- Si un vendedor no tiene GPS: [[ir:Ir al CRM|crm]]
SIEMPRE incluye al menos 1 botón de acción cuando sea relevante. Puedes poner varios en líneas separadas.

${contextBlock}${sheetsCtx}${learningsCtx}`;
}

/**
 * POST /api/ai/route-chat
 * Asistente conversacional con contexto completo de la plataforma.
 * Body: { message, platformContext, routeContext, history }
 */
app.post('/api/ai/route-chat', authenticate, aiLimiter, async (req, res) => {
  try {
    if (!openai) return res.status(400).json({ success: false, error: 'OpenAI no configurado' });
    const { message, platformContext, routeContext, history = [] } = req.body;
    if (!message) return res.status(400).json({ success: false, error: 'Mensaje requerido' });

    // Construir contexto de plataforma para el prompt
    let contextBlock = '';

    contextBlock = _buildPlatformContextBlock(platformContext, routeContext);

    // Incluir datos reales de Google Sheets (ventas, cobranzas, 80-20) — con caché 5min
    const sheetsCtx = await _buildSheetsContext().catch(() => '');

    const systemPrompt = await _buildAiSystemPrompt(contextBlock, sheetsCtx);

    const recentHistory = history.slice(-8).map(m => ({ role: m.role, content: m.content }));

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.4,
      max_tokens: 800,
      messages: [
        { role: 'system', content: systemPrompt },
        ...recentHistory,
        { role: 'user', content: message }
      ]
    });

    const reply = completion.choices[0].message.content.trim();
    _trackAiUsage('route-chat', req.user?.id, req.user?.full_name, completion.usage);
    res.json({ success: true, reply, tokensUsed: completion.usage?.total_tokens || 0 });
  } catch (error) {
    console.error('[AI route-chat]', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/ai/route-chat/stream
 * Versión streaming del chat — texto aparece en tiempo real (SSE)
 */
app.post('/api/ai/route-chat/stream', authenticate, aiLimiter, async (req, res) => {
  try {
    if (!openai) return res.status(400).json({ success: false, error: 'OpenAI no configurado' });
    const { message, platformContext, history = [], conversationId } = req.body;
    if (!message) return res.status(400).json({ success: false, error: 'Mensaje requerido' });

    const contextBlock = _buildPlatformContextBlock(platformContext, null);
    const sheetsCtx = await _buildSheetsContext().catch(() => '');
    const systemPrompt = await _buildAiSystemPrompt(contextBlock, sheetsCtx);

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Load DB history if conversationId provided and no frontend history
    let dbHistory = [];
    if (conversationId && history.length === 0) {
      const { data: dbMsgs } = await supabase.from('ai_messages')
        .select('role,content').eq('conversation_id', conversationId)
        .order('created_at', { ascending: true }).limit(20);
      if (dbMsgs) dbHistory = dbMsgs.map(m => ({ role: m.role, content: m.content }));
    }

    const recentHistory = (history.length > 0 ? history : dbHistory).slice(-8).map(m => ({ role: m.role, content: m.content }));
    const stream = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.4,
      max_tokens: 800,
      stream: true,
      messages: [
        { role: 'system', content: systemPrompt },
        ...recentHistory,
        { role: 'user', content: message }
      ]
    });

    let totalTokens = 0;
    let fullResponse = '';
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || '';
      if (delta) {
        fullResponse += delta;
        res.write(`data: ${JSON.stringify({ delta })}\n\n`);
      }
      if (chunk.usage) totalTokens = chunk.usage.total_tokens;
    }
    _trackAiUsage('route-chat-stream', req.user?.id, req.user?.full_name, { total_tokens: totalTokens });

    // Persist conversation in DB (awaited so conversationId is available for done event)
    let activeConvId = conversationId;
    try {
      if (!activeConvId) {
        const title = message.length > 50 ? message.slice(0, 50) + '...' : message;
        const { data: conv } = await supabase.from('ai_conversations')
          .insert({ user_id: req.user.id, title }).select('id').single();
        if (conv) activeConvId = conv.id;
      } else {
        await supabase.from('ai_conversations').update({ updated_at: new Date().toISOString() }).eq('id', activeConvId);
      }
      if (activeConvId) {
        await supabase.from('ai_messages').insert([
          { conversation_id: activeConvId, role: 'user', content: message },
          { conversation_id: activeConvId, role: 'assistant', content: fullResponse }
        ]);
      }

      // Auto-learn detection: "aprende", "recuerda", "memoriza"
      const learnMatch = message.match(/^(aprende|recuerda|memoriza|guarda|anota)\s+(?:que\s+)?(.+)/i);
      if (learnMatch) {
        const learnContent = learnMatch[2].trim();
        const extraction = await openai.chat.completions.create({
          model: 'gpt-4o', temperature: 0.2, max_tokens: 200,
          messages: [
            { role: 'system', content: 'Extrae un aprendizaje de negocio del texto. Responde JSON: {"category":"general|ventas|rutas|clientes|productos|politicas","title":"titulo corto","content":"explicación"}. SOLO JSON.' },
            { role: 'user', content: learnContent }
          ]
        });
        try {
          const parsed = JSON.parse(extraction.choices[0].message.content.trim());
          if (parsed.title && parsed.content) {
            await _ensureAiLearningsTable();
            await supabase.from('ai_learnings').insert({
              category: parsed.category || 'general',
              title: parsed.title,
              content: parsed.content,
              created_by: req.user.id
            });
            _learningsCache = null;
            res.write(`data: ${JSON.stringify({ learning_created: { title: parsed.title, category: parsed.category } })}\n\n`);
          }
        } catch (_parseErr) { /* ignore parse errors */ }
      }
    } catch (e) {
      console.error('[AI persist]', e.message);
    }

    res.write(`data: ${JSON.stringify({ done: true, tokensUsed: totalTokens, conversationId: activeConvId })}\n\n`);
    res.end();
  } catch (error) {
    console.error('[AI stream]', error.message);
    try { res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`); res.end(); } catch(_) {}
  }
});

// =============================================
// AI CONVERSATIONS — Historial persistente
// =============================================

// GET /api/ai/conversations — listar conversaciones del usuario
app.get('/api/ai/conversations', authenticate, async (req, res) => {
  try {
    const { data, error } = await supabase.from('ai_conversations')
      .select('id,title,created_at,updated_at')
      .eq('user_id', req.user.id)
      .order('updated_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/ai/conversations/:id/messages — cargar mensajes de una conversación
app.get('/api/ai/conversations/:id/messages', authenticate, async (req, res) => {
  try {
    // Verify ownership
    const { data: conv } = await supabase.from('ai_conversations')
      .select('id').eq('id', req.params.id).eq('user_id', req.user.id).single();
    if (!conv) return res.status(404).json({ success: false, error: 'Conversación no encontrada' });

    const { data, error } = await supabase.from('ai_messages')
      .select('id,role,content,created_at')
      .eq('conversation_id', req.params.id)
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/ai/conversations/:id — eliminar conversación
app.delete('/api/ai/conversations/:id', authenticate, async (req, res) => {
  try {
    const { error } = await supabase.from('ai_conversations')
      .delete().eq('id', req.params.id).eq('user_id', req.user.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// PATCH /api/ai/conversations/:id — renombrar conversación
app.patch('/api/ai/conversations/:id', authenticate, async (req, res) => {
  try {
    const { title } = req.body;
    if (!title) return res.status(400).json({ success: false, error: 'Título requerido' });
    const { error } = await supabase.from('ai_conversations')
      .update({ title }).eq('id', req.params.id).eq('user_id', req.user.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// =============================================
// AI USAGE STATS
// =============================================

// GET /api/ai/usage — estadísticas de uso de IA
app.get('/api/ai/usage', authenticate, authorize('admin', 'supervisor'), async (req, res) => {
  // Pricing GPT-4o: $2.50/1M input, $10.00/1M output
  const inputCost = (_aiUsage.totalInputTokens / 1_000_000) * 0.15;
  const outputCost = (_aiUsage.totalOutputTokens / 1_000_000) * 0.60;
  const totalCost = inputCost + outputCost;

  res.json({
    success: true,
    data: {
      totalRequests: _aiUsage.totalRequests,
      totalTokens: _aiUsage.totalTokens,
      totalInputTokens: _aiUsage.totalInputTokens,
      totalOutputTokens: _aiUsage.totalOutputTokens,
      estimatedCostUSD: Math.round(totalCost * 10000) / 10000,
      model: 'gpt-4o',
      pricing: { input: '$0.15/1M tokens', output: '$0.60/1M tokens' },
      byEndpoint: _aiUsage.byEndpoint,
      byUser: _aiUsage.byUser,
      history: _aiUsage.history,
      serverStartedAt: _aiUsage.serverStartedAt
    }
  });
});

// =============================================
// AI LEARNINGS — Memoria persistente de la IA
// =============================================

// Auto-create table on first use
let _aiLearningsTableReady = false;
async function _ensureAiLearningsTable() {
  if (_aiLearningsTableReady) return;
  try {
    const { error } = await supabase.from('ai_learnings').select('id').limit(1);
    if (error && error.code === 'PGRST205') {
      // Table doesn't exist — create via raw SQL
      const { error: sqlErr } = await supabase.rpc('exec_sql', {
        sql: `CREATE TABLE IF NOT EXISTS ai_learnings (
          id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
          category TEXT NOT NULL DEFAULT 'general',
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          active BOOLEAN DEFAULT true,
          created_by UUID,
          created_at TIMESTAMPTZ DEFAULT now(),
          updated_at TIMESTAMPTZ DEFAULT now()
        )`
      });
      if (sqlErr) console.log('[ai_learnings] Could not auto-create table, create manually:', sqlErr.message);
    }
    _aiLearningsTableReady = true;
  } catch (e) {
    console.log('[ai_learnings] init:', e.message);
  }
}

// Build learnings context for AI prompts
let _learningsCache = null;
let _learningsCachedAt = 0;
const LEARNINGS_TTL = 5 * 60 * 1000; // 5 min cache

async function _buildLearningsContext() {
  if (_learningsCache && (Date.now() - _learningsCachedAt) < LEARNINGS_TTL) return _learningsCache;
  try {
    await _ensureAiLearningsTable();
    const { data } = await supabase.from('ai_learnings').select('category,title,content').eq('active', true).order('category');
    if (!data || data.length === 0) { _learningsCache = ''; _learningsCachedAt = Date.now(); return ''; }

    let ctx = '\n=== REGLAS Y APRENDIZAJES DE LA EMPRESA ===\n';
    ctx += 'IMPORTANTE: Estas son reglas y conocimientos que la empresa ha definido. SIEMPRE respétalas.\n';
    const byCategory = {};
    data.forEach(l => {
      if (!byCategory[l.category]) byCategory[l.category] = [];
      byCategory[l.category].push(l);
    });
    Object.entries(byCategory).forEach(([cat, items]) => {
      ctx += `\n[${cat.toUpperCase()}]\n`;
      items.forEach(l => { ctx += `• ${l.title}: ${l.content}\n`; });
    });
    _learningsCache = ctx;
    _learningsCachedAt = Date.now();
    return ctx;
  } catch (e) {
    return '';
  }
}

// POST /api/ai/learnings/upload — subir documento, IA lo resume y crea aprendizajes
app.post('/api/ai/learnings/upload', authenticate, authorize('admin', 'supervisor'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'Archivo requerido' });
    if (!openai) return res.status(400).json({ success: false, error: 'OpenAI no configurado' });

    const { originalname, buffer, mimetype } = req.file;
    const category = req.body.category || 'general';
    let text = '';

    // Extraer texto según tipo
    if (mimetype === 'text/plain' || originalname.endsWith('.txt') || originalname.endsWith('.csv')) {
      text = buffer.toString('utf-8');
    } else if (mimetype === 'application/pdf' || originalname.endsWith('.pdf')) {
      // PDF: intentar extraer texto simple (sin dependencia extra)
      const raw = buffer.toString('utf-8');
      // Extraer strings legibles del PDF
      text = raw.replace(/[^\x20-\x7E\xC0-\xFF\n]/g, ' ').replace(/\s{3,}/g, '\n').trim();
      if (text.length < 50) text = '[PDF con contenido no legible como texto plano. Contenido binario.]';
    } else if (originalname.endsWith('.xlsx') || originalname.endsWith('.xls')) {
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      const sheets = workbook.SheetNames.map(name => {
        const data = XLSX.utils.sheet_to_csv(workbook.Sheets[name], { FS: ' | ' });
        return `[${name}]\n${data}`;
      });
      text = sheets.join('\n\n');
    } else if (mimetype.startsWith('text/') || originalname.endsWith('.md') || originalname.endsWith('.json')) {
      text = buffer.toString('utf-8');
    } else {
      return res.status(400).json({ success: false, error: 'Formato no soportado. Usa TXT, PDF, XLSX, CSV o MD.' });
    }

    // Limitar texto para no exceder tokens
    const maxChars = 12000;
    const truncated = text.length > maxChars;
    const textForAI = text.slice(0, maxChars);

    // Pedir a la IA que resuma y extraiga reglas/aprendizajes
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.3,
      max_tokens: 1200,
      messages: [
        { role: 'system', content: `Eres un asistente que analiza documentos de empresa.
Tu tarea es extraer los puntos clave, reglas, datos importantes o conocimientos del documento.

Responde en este formato JSON exacto (array de objetos):
[
  { "title": "Título corto de la regla/dato", "content": "Explicación clara y concisa" },
  ...
]

Máximo 8 items. Cada item debe ser un aprendizaje útil e independiente.
Si el documento tiene datos numéricos o tablas, extrae los más relevantes.
Responde SOLO con el JSON, sin texto adicional.` },
        { role: 'user', content: `Documento: "${originalname}"${truncated ? ' (truncado)' : ''}\nCategoría: ${category}\n\nContenido:\n${textForAI}` }
      ]
    });

    _trackAiUsage('learnings-upload', req.user?.id, req.user?.full_name, completion.usage);

    const aiResponse = completion.choices[0].message.content.trim();
    let learnings = [];
    try {
      // Limpiar posible markdown wrapper
      const clean = aiResponse.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
      learnings = JSON.parse(clean);
    } catch (e) {
      return res.json({ success: true, data: [], summary: aiResponse, parseError: true, fileName: originalname });
    }

    // Guardar cada aprendizaje en la DB
    await _ensureAiLearningsTable();
    const saved = [];
    for (const l of learnings) {
      if (!l.title || !l.content) continue;
      const { data, error } = await supabase.from('ai_learnings').insert({
        category, title: l.title, content: l.content, active: true, created_by: req.user.id
      }).select().single();
      if (data) saved.push(data);
    }
    _learningsCache = null; // invalidar caché

    res.json({ success: true, data: saved, total: saved.length, fileName: originalname });
  } catch (e) {
    console.error('[AI learnings upload]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/ai/learnings/import-url — importar desde URL (Google Docs, Sheets, Drive, web)
app.post('/api/ai/learnings/import-url', authenticate, authorize('admin', 'supervisor'), async (req, res) => {
  try {
    const { url, category = 'general' } = req.body;
    if (!url) return res.status(400).json({ success: false, error: 'URL requerida' });
    if (!openai) return res.status(400).json({ success: false, error: 'OpenAI no configurado' });

    let fetchUrl = url.trim();
    let sourceName = fetchUrl;

    // Detectar Google Docs → export como texto plano
    const gdocMatch = fetchUrl.match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/);
    if (gdocMatch) {
      fetchUrl = `https://docs.google.com/document/d/${gdocMatch[1]}/export?format=txt`;
      sourceName = 'Google Doc';
    }

    // Detectar Google Sheets → export como CSV
    const gsheetMatch = !gdocMatch && fetchUrl.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (gsheetMatch) {
      fetchUrl = `https://docs.google.com/spreadsheets/d/${gsheetMatch[1]}/export?format=csv`;
      sourceName = 'Google Sheet';
    }

    // Detectar Google Drive file → download directo
    const gdriveMatch = !gdocMatch && !gsheetMatch && fetchUrl.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (gdriveMatch) {
      fetchUrl = `https://drive.google.com/uc?export=download&id=${gdriveMatch[1]}`;
      sourceName = 'Google Drive';
    }

    // Detectar Google Drive open?id= format
    const gdriveOpen = !gdocMatch && !gsheetMatch && !gdriveMatch && fetchUrl.match(/drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/);
    if (gdriveOpen) {
      fetchUrl = `https://drive.google.com/uc?export=download&id=${gdriveOpen[1]}`;
      sourceName = 'Google Drive';
    }

    // Fetch content
    const response = await fetch(fetchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LekerBot/1.0)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      return res.status(400).json({ success: false, error: `No se pudo acceder a la URL (${response.status}). Verifica que el link sea público.` });
    }

    const contentType = response.headers.get('content-type') || '';
    let text = '';

    if (contentType.includes('text/') || contentType.includes('json') || contentType.includes('csv')) {
      text = await response.text();
      // Si es HTML, extraer solo el texto visible
      if (contentType.includes('html')) {
        text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                    .replace(/<[^>]+>/g, ' ')
                    .replace(/&nbsp;/g, ' ')
                    .replace(/&amp;/g, '&')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&#?\w+;/g, ' ')
                    .replace(/\s{2,}/g, ' ')
                    .trim();
        sourceName = sourceName === fetchUrl ? 'Página web' : sourceName;
      }
    } else if (contentType.includes('application/pdf')) {
      const buffer = Buffer.from(await response.arrayBuffer());
      text = buffer.toString('utf-8').replace(/[^\x20-\x7E\xC0-\xFF\n]/g, ' ').replace(/\s{3,}/g, '\n').trim();
      if (text.length < 50) text = '[PDF con contenido no legible como texto plano]';
      sourceName = sourceName === fetchUrl ? 'PDF online' : sourceName;
    } else if (contentType.includes('spreadsheet') || contentType.includes('excel')) {
      const buffer = Buffer.from(await response.arrayBuffer());
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      text = workbook.SheetNames.map(name => {
        const data = XLSX.utils.sheet_to_csv(workbook.Sheets[name], { FS: ' | ' });
        return `[${name}]\n${data}`;
      }).join('\n\n');
      sourceName = sourceName === fetchUrl ? 'Excel online' : sourceName;
    } else {
      // Intentar como texto
      text = await response.text();
      if (!text || text.length < 10) {
        return res.status(400).json({ success: false, error: 'No se pudo extraer contenido del enlace. Formato no soportado.' });
      }
    }

    if (!text || text.trim().length < 20) {
      return res.status(400).json({ success: false, error: 'El documento no tiene contenido suficiente para extraer aprendizajes.' });
    }

    // Limitar texto
    const maxChars = 12000;
    const truncated = text.length > maxChars;
    const textForAI = text.slice(0, maxChars);

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.3,
      max_tokens: 1200,
      messages: [
        { role: 'system', content: `Eres un asistente que analiza documentos de empresa.
Tu tarea es extraer los puntos clave, reglas, datos importantes o conocimientos del documento.

Responde en este formato JSON exacto (array de objetos):
[
  { "title": "Título corto de la regla/dato", "content": "Explicación clara y concisa" },
  ...
]

Máximo 8 items. Cada item debe ser un aprendizaje útil e independiente.
Si el documento tiene datos numéricos o tablas, extrae los más relevantes.
Responde SOLO con el JSON, sin texto adicional.` },
        { role: 'user', content: `Documento importado desde: ${sourceName}${truncated ? ' (truncado)' : ''}\nCategoría: ${category}\n\nContenido:\n${textForAI}` }
      ]
    });

    _trackAiUsage('learnings-import-url', req.user?.id, req.user?.full_name, completion.usage);

    const aiResponse = completion.choices[0].message.content.trim();
    let learnings = [];
    try {
      const clean = aiResponse.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
      learnings = JSON.parse(clean);
    } catch (e) {
      return res.json({ success: true, data: [], summary: aiResponse, parseError: true, sourceName });
    }

    await _ensureAiLearningsTable();
    const saved = [];
    for (const l of learnings) {
      if (!l.title || !l.content) continue;
      const { data, error } = await supabase.from('ai_learnings').insert({
        category, title: l.title, content: l.content, active: true, created_by: req.user.id
      }).select().single();
      if (data) saved.push(data);
    }
    _learningsCache = null;

    res.json({ success: true, data: saved, total: saved.length, sourceName });
  } catch (e) {
    console.error('[AI learnings import-url]', e.message);
    if (e.name === 'TimeoutError') {
      return res.status(400).json({ success: false, error: 'La URL tardó demasiado en responder. Verifica el enlace.' });
    }
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/ai/learnings — listar todos
app.get('/api/ai/learnings', authenticate, authorize('admin', 'supervisor'), async (req, res) => {
  try {
    await _ensureAiLearningsTable();
    const { data, error } = await supabase.from('ai_learnings').select('*').order('category').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ success: false, error: error.message });
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/ai/learnings — crear
app.post('/api/ai/learnings', authenticate, authorize('admin', 'supervisor'), async (req, res) => {
  try {
    await _ensureAiLearningsTable();
    const { category, title, content } = req.body;
    if (!title || !content) return res.status(400).json({ success: false, error: 'Título y contenido requeridos' });
    const { data, error } = await supabase.from('ai_learnings').insert({
      category: category || 'general', title, content, active: true, created_by: req.user.id
    }).select().single();
    if (error) return res.status(500).json({ success: false, error: error.message });
    _learningsCache = null; // invalidate cache
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// PUT /api/ai/learnings/:id — actualizar
app.put('/api/ai/learnings/:id', authenticate, authorize('admin', 'supervisor'), async (req, res) => {
  try {
    const { category, title, content, active } = req.body;
    const updates = { updated_at: new Date().toISOString() };
    if (category !== undefined) updates.category = category;
    if (title !== undefined) updates.title = title;
    if (content !== undefined) updates.content = content;
    if (active !== undefined) updates.active = active;
    const { data, error } = await supabase.from('ai_learnings').update(updates).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ success: false, error: error.message });
    _learningsCache = null;
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/ai/learnings/:id — eliminar
app.delete('/api/ai/learnings/:id', authenticate, authorize('admin', 'supervisor'), async (req, res) => {
  try {
    const { error } = await supabase.from('ai_learnings').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ success: false, error: error.message });
    _learningsCache = null;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = app;
