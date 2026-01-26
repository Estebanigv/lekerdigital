const express = require('express');
const cors = require('cors');
const path = require('path');

// Import services
const routesService = require('./modules/routes/routes.service');
const intelligenceService = require('./modules/market-intelligence/intelligence.service');

const app = express();

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
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
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
    const { routeId, clientId, outcome, audioUrl } = req.body;
    const result = await routesService.checkIn({ routeId, clientId, outcome, audioUrl });
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
