const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');

// Import services
const routesService = require('./modules/routes/routes.service');
const intelligenceService = require('./modules/market-intelligence/intelligence.service');

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
// API ENDPOINTS - DATOS AUXILIARES (para UI)
// =============================================

app.get('/api/users', async (req, res) => {
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
    const client = await routesService.updateClient(req.params.id, req.body);
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

app.post('/api/users', async (req, res) => {
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

app.delete('/api/users/:id', async (req, res) => {
  try {
    await routesService.deleteUser(req.params.id);
    res.json({ success: true, message: 'Vendedor eliminado' });
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

// =============================================
// IMPORTACIÓN DE EXCEL
// =============================================

app.post('/api/upload/clients', upload.single('file'), async (req, res) => {
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
app.post('/api/upload/users', upload.single('file'), async (req, res) => {
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
app.post('/api/upload/vehicles', upload.single('file'), async (req, res) => {
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
    const { routeId, clientId, outcome, audioUrl, lat, lng } = req.body;
    const result = await routesService.checkIn({ routeId, clientId, outcome, audioUrl, lat, lng });
    res.status(201).json({
      success: true,
      message: 'Visita registrada correctamente',
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

// =============================================
// MÓDULO 2: INTELIGENCIA DE MERCADO
// =============================================

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

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    mode: 'PRODUCTION',
    database: 'Supabase',
    timestamp: new Date().toISOString()
  });
});

module.exports = app;
