const express = require('express');
const { body, param } = require('express-validator');
const router = express.Router();

const routesController = require('./routes.controller');
const { validate } = require('../../middlewares/validation');

/**
 * POST /routes/start
 * Inicia el día de un vendedor
 */
router.post(
  '/start',
  [
    body('userId').isUUID().withMessage('userId debe ser un UUID válido'),
    body('vehicleId').isUUID().withMessage('vehicleId debe ser un UUID válido'),
    body('startKm').isNumeric().withMessage('startKm debe ser un número'),
    validate
  ],
  routesController.startDay
);

/**
 * POST /routes/checkin
 * Registra una visita
 */
router.post(
  '/checkin',
  [
    body('routeId').isUUID().withMessage('routeId debe ser un UUID válido'),
    body('clientId').isUUID().withMessage('clientId debe ser un UUID válido'),
    body('outcome')
      .optional()
      .isIn(['pending', 'contacted', 'no_contact', 'sale'])
      .withMessage('outcome debe ser: pending, contacted, no_contact o sale'),
    body('audioUrl').optional().isURL().withMessage('audioUrl debe ser una URL válida'),
    validate
  ],
  routesController.checkIn
);

/**
 * GET /routes/active/:userId
 * Obtiene la ruta activa del día
 */
router.get(
  '/active/:userId',
  [
    param('userId').isUUID().withMessage('userId debe ser un UUID válido'),
    validate
  ],
  routesController.getActiveRoute
);

/**
 * GET /routes/optimize/:userId
 * Obtiene ruta optimizada para un vendedor
 */
router.get(
  '/optimize/:userId',
  [
    param('userId').isUUID().withMessage('userId debe ser un UUID válido'),
    validate
  ],
  routesController.getOptimizedRoute
);

/**
 * GET /routes/vehicle-config
 * Obtiene configuración de vehículo estándar
 */
router.get('/vehicle-config', routesController.getVehicleConfig);

/**
 * GET /routes/calculate-cost
 * Calcula distancia y costo entre dos puntos
 */
router.get('/calculate-cost', routesController.calculateCost);

module.exports = router;
