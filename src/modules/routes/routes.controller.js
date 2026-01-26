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
}

module.exports = new RoutesController();
