const intelligenceService = require('./intelligence.service');

class IntelligenceController {
  /**
   * POST /webhooks/n8n-price-update
   * Recibe actualizaciones de precios desde n8n
   *
   * Formato esperado del body:
   * {
   *   "prices": [
   *     {
   *       "productSku": "SKU-001",
   *       "competitorName": "Sodimac",
   *       "detectedPrice": 15990,
   *       "source": "n8n_scraper",
   *       "evidenceUrl": "https://..."
   *     }
   *   ]
   * }
   *
   * O formato simplificado (un solo precio):
   * {
   *   "productSku": "SKU-001",
   *   "competitorName": "Sodimac",
   *   "detectedPrice": 15990
   * }
   */
  async n8nPriceUpdate(req, res) {
    try {
      const { prices, productSku, competitorName, detectedPrice, source, evidenceUrl } = req.body;

      // Determinar si es formato array o individual
      const priceData = prices || { productSku, competitorName, detectedPrice, source, evidenceUrl };

      const results = await intelligenceService.processPriceUpdate(priceData);

      const hasErrors = results.errors.length > 0;
      const statusCode = hasErrors ? 207 : 200; // 207 = Multi-Status

      res.status(statusCode).json({
        success: !hasErrors || results.inserted.length > 0,
        message: `Procesados: ${results.inserted.length}, Errores: ${results.errors.length}`,
        data: results
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * GET /intelligence/product/:productId/history
   * Obtiene histórico de precios de un producto
   */
  async getPriceHistory(req, res) {
    try {
      const { productId } = req.params;
      const { days } = req.query;

      const history = await intelligenceService.getPriceHistory(
        productId,
        days ? parseInt(days) : 30
      );

      res.json({
        success: true,
        data: history
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * GET /intelligence/product/:productId/comparison
   * Obtiene comparativa de precios actual
   */
  async getPriceComparison(req, res) {
    try {
      const { productId } = req.params;

      const comparison = await intelligenceService.getPriceComparison(productId);

      res.json({
        success: true,
        data: comparison
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
}

module.exports = new IntelligenceController();
