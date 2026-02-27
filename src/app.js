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

// Auth
const authRouter = require('./modules/auth/auth.controller');
const { authenticate, authorize } = require('./middlewares/auth');

const app = express();

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB max
});

app.use(cors());
app.use(express.json());
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
  authenticate(req, res, next);
});
app.use('/routes', authenticate);

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
app.post('/api/assistant/chat', authenticate, async (req, res) => {
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
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
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
    const client = await routesService.createClient(req.body);
    res.status(201).json({ success: true, message: 'Cliente creado', data: client });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.put('/api/clients/:id', async (req, res) => {
  try {
    const userId = req.user ? req.user.id : null;
    const client = await routesService.updateClient(req.params.id, req.body, userId);
    res.json({ success: true, message: 'Cliente actualizado', data: client });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
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

app.post('/routes/:routeId/end', async (req, res) => {
  try {
    const { endKm } = req.body;
    const result = await routesService.endDay(req.params.routeId, endKm);
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
    const { zone, startLat, startLng, exclude } = req.query;
    let startPoint = null;
    if (startLat && startLng) {
      startPoint = { lat: parseFloat(startLat), lng: parseFloat(startLng) };
    }
    const excludeIds = exclude ? exclude.split(',').filter(Boolean) : [];
    const result = await routesService.getOptimizedRoute(req.params.userId, zone, startPoint, excludeIds);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Obtener configuración de vehículo estándar
app.get('/routes/vehicle-config', (req, res) => {
  res.json({ success: true, data: routesService.getVehicleConfig() });
});

// =============================================
// MÓDULO 2: INTELIGENCIA DE MERCADO
// =============================================

// =============================================
// WEBHOOKS N8N - ENTRADA (n8n → LEKER)
// =============================================

// Webhook: Actualización de precios (scraping)
app.post('/webhooks/n8n-price-update', async (req, res) => {
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
app.post('/webhooks/n8n-sync-clients', async (req, res) => {
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
app.post('/webhooks/n8n-sync-products', async (req, res) => {
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
app.post('/webhooks/n8n-sync-users', async (req, res) => {
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
app.post('/webhooks/n8n-comparativo', async (req, res) => {
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
    scriptUrl: googleSheetsService.isConfigured() ? googleSheetsService.scriptUrl : null
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

app.get('/api/gsheets/:sheet', async (req, res) => {
  try {
    const data = await googleSheetsService.getSheet(req.params.sheet);
    res.json({ success: true, data });
  } catch (error) {
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

module.exports = app;
