const routesService = require('./routes.service');

class RoutesController {
  /**
   * POST /routes/start
   * Inicia el día de un vendedor
   */
  async startDay(req, res) {
    try {
      const { userId, vehicleId, startKm } = req.body;

      const result = await routesService.startDay({
        userId,
        vehicleId,
        startKm
      });

      res.status(201).json({
        success: true,
        message: 'Día iniciado correctamente',
        data: result
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * POST /routes/checkin
   * Registra una visita a un cliente
   */
  async checkIn(req, res) {
    try {
      const { routeId, clientId, outcome, audioUrl } = req.body;

      const result = await routesService.checkIn({
        routeId,
        clientId,
        outcome,
        audioUrl
      });

      res.status(201).json({
        success: true,
        message: 'Visita registrada correctamente',
        data: result
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * GET /routes/active/:userId
   * Obtiene la ruta activa del día
   */
  async getActiveRoute(req, res) {
    try {
      const { userId } = req.params;

      const route = await routesService.getActiveRoute(userId);

      if (!route) {
        return res.status(404).json({
          success: false,
          error: 'No hay ruta activa para hoy'
        });
      }

      res.json({
        success: true,
        data: route
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * GET /routes/zones/:userId
   * Obtiene las zonas disponibles para un vendedor
   */
  async getVendorZones(req, res) {
    try {
      const { userId } = req.params;
      const zones = await routesService.getVendorZones(userId);

      res.json({
        success: true,
        data: zones
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * GET /routes/optimize/:userId
   * Obtiene ruta optimizada para un vendedor (filtrada por zona)
   */
  async getOptimizedRoute(req, res) {
    try {
      const { userId } = req.params;
      const { zone, startLat, startLng } = req.query;

      let startPoint = null;
      if (startLat && startLng) {
        startPoint = {
          lat: parseFloat(startLat),
          lng: parseFloat(startLng)
        };
      }

      const result = await routesService.getOptimizedRoute(userId, zone, startPoint);

      res.json({
        success: true,
        data: result
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * GET /routes/vehicle-config
   * Obtiene configuración de vehículo estándar
   */
  async getVehicleConfig(req, res) {
    try {
      const config = routesService.getVehicleConfig();
      res.json({
        success: true,
        data: config
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * GET /routes/calculate-cost
   * Calcula distancia y costo entre dos puntos
   */
  async calculateCost(req, res) {
    try {
      const { lat1, lng1, lat2, lng2 } = req.query;

      if (!lat1 || !lng1 || !lat2 || !lng2) {
        return res.status(400).json({
          success: false,
          error: 'Se requieren lat1, lng1, lat2, lng2'
        });
      }

      const result = routesService.calculateDistanceCost(
        parseFloat(lat1), parseFloat(lng1),
        parseFloat(lat2), parseFloat(lng2)
      );

      res.json({
        success: true,
        data: result
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
}

module.exports = new RoutesController();
