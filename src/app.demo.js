const express = require('express');
const cors = require('cors');
const path = require('path');

// Import mock services
const routesService = require('./modules/routes/routes.service.mock');
const intelligenceService = require('./modules/market-intelligence/intelligence.service.mock');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// =============================================
// API ENDPOINTS - DATOS AUXILIARES (para UI)
// =============================================

app.get('/api/users', (req, res) => {
  res.json({ success: true, data: routesService.getAllUsers() });
});

app.get('/api/vehicles', (req, res) => {
  res.json({ success: true, data: routesService.getAllVehicles() });
});

app.get('/api/clients', (req, res) => {
  res.json({ success: true, data: routesService.getAllClients() });
});

app.get('/api/products', (req, res) => {
  res.json({ success: true, data: intelligenceService.getAllProducts() });
});

app.get('/api/competitors', (req, res) => {
  res.json({ success: true, data: intelligenceService.getAllCompetitors() });
});

app.get('/api/daily-routes', (req, res) => {
  res.json({ success: true, data: routesService.getAllRoutes() });
});

app.get('/api/daily-routes/today', (req, res) => {
  res.json({ success: true, data: routesService.getTodayRoutes() });
});

app.get('/api/daily-routes/:routeId', (req, res) => {
  const route = routesService.getRouteWithVisits(req.params.routeId);
  if (!route) {
    return res.status(404).json({ success: false, error: 'Ruta no encontrada' });
  }
  res.json({ success: true, data: route });
});

app.get('/api/users/:userId/routes', (req, res) => {
  res.json({ success: true, data: routesService.getRoutesByUser(req.params.userId) });
});

app.get('/api/price-intelligence', (req, res) => {
  res.json({ success: true, data: intelligenceService.getAllPrices() });
});

// =============================================
// GESTIÓN DE VENDEDORES
// =============================================

app.post('/api/users', (req, res) => {
  try {
    const { fullName, email, role } = req.body;
    if (!fullName || !email) {
      return res.status(400).json({ success: false, error: 'Nombre y email son requeridos' });
    }
    const user = routesService.createUser({ fullName, email, role });
    res.status(201).json({ success: true, message: 'Vendedor creado', data: user });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.delete('/api/users/:id', (req, res) => {
  try {
    routesService.deleteUser(req.params.id);
    res.json({ success: true, message: 'Vendedor eliminado' });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// =============================================
// GESTIÓN DE VEHÍCULOS
// =============================================

app.post('/api/vehicles', (req, res) => {
  try {
    const { licensePlate, model, fuelEfficiency } = req.body;
    if (!licensePlate || !model) {
      return res.status(400).json({ success: false, error: 'Patente y modelo son requeridos' });
    }
    const vehicle = routesService.createVehicle({ licensePlate, model, fuelEfficiency });
    res.status(201).json({ success: true, message: 'Vehículo creado', data: vehicle });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.delete('/api/vehicles/:id', (req, res) => {
  try {
    routesService.deleteVehicle(req.params.id);
    res.json({ success: true, message: 'Vehículo eliminado' });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.patch('/api/vehicles/:id/status', (req, res) => {
  try {
    const { status } = req.body;
    const vehicle = routesService.updateVehicleStatus(req.params.id, status);
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
  res.json({ status: 'ok', mode: 'DEMO', timestamp: new Date().toISOString() });
});

module.exports = app;
