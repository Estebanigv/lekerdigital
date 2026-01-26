const express = require('express');
const { body, param, query } = require('express-validator');
const router = express.Router();

const intelligenceController = require('./intelligence.controller');
const { validate } = require('../../middlewares/validation');
const { webhookAuth } = require('../../middlewares/webhookAuth');

/**
 * POST /webhooks/n8n-price-update
 * Endpoint para recibir actualizaciones de precios desde n8n
 * Protegido con webhook secret opcional
 */
router.post(
  '/webhooks/n8n-price-update',
  webhookAuth,
  [
    // Validar formato array
    body('prices').optional().isArray().withMessage('prices debe ser un array'),
    body('prices.*.productSku').optional().isString().withMessage('productSku debe ser string'),
    body('prices.*.competitorName').optional().isString().withMessage('competitorName debe ser string'),
    body('prices.*.detectedPrice').optional().isNumeric().withMessage('detectedPrice debe ser número'),

    // Validar formato individual
    body('productSku').optional().isString().withMessage('productSku debe ser string'),
    body('competitorName').optional().isString().withMessage('competitorName debe ser string'),
    body('detectedPrice').optional().isNumeric().withMessage('detectedPrice debe ser número'),
    body('source')
      .optional()
      .isIn(['n8n_scraper', 'sales_rep_report'])
      .withMessage('source debe ser: n8n_scraper o sales_rep_report'),
    validate
  ],
  intelligenceController.n8nPriceUpdate
);

/**
 * GET /intelligence/product/:productId/history
 * Obtiene histórico de precios
 */
router.get(
  '/intelligence/product/:productId/history',
  [
    param('productId').isUUID().withMessage('productId debe ser UUID válido'),
    query('days').optional().isInt({ min: 1, max: 365 }).withMessage('days debe ser entre 1 y 365'),
    validate
  ],
  intelligenceController.getPriceHistory
);

/**
 * GET /intelligence/product/:productId/comparison
 * Obtiene comparativa de precios actual
 */
router.get(
  '/intelligence/product/:productId/comparison',
  [
    param('productId').isUUID().withMessage('productId debe ser UUID válido'),
    validate
  ],
  intelligenceController.getPriceComparison
);

module.exports = router;
