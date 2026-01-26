const {
  mockProducts,
  mockCompetitors,
  mockPriceIntelligence
} = require('../../config/mockData');

class IntelligenceServiceMock {
  async processPriceUpdate(priceData) {
    const prices = Array.isArray(priceData) ? priceData : [priceData];
    const results = {
      inserted: [],
      errors: []
    };

    for (const price of prices) {
      try {
        const record = await this.insertPriceRecord(price);
        results.inserted.push(record);
      } catch (error) {
        results.errors.push({
          input: price,
          error: error.message
        });
      }
    }

    return results;
  }

  async insertPriceRecord({ productSku, competitorName, detectedPrice, source, evidenceUrl }) {
    const product = mockProducts.find(p => p.sku === productSku);
    if (!product) {
      throw new Error(`Producto con SKU '${productSku}' no encontrado`);
    }

    let competitor = mockCompetitors.find(c => c.name === competitorName);
    if (!competitor) {
      competitor = {
        id: `comp-${Date.now()}`,
        name: competitorName,
        website_url: null
      };
      mockCompetitors.push(competitor);
    }

    const record = {
      id: `pi-${Date.now()}`,
      product_id: product.id,
      competitor_id: competitor.id,
      detected_price: detectedPrice,
      captured_at: new Date().toISOString(),
      source: source || 'n8n_scraper',
      evidence_url: evidenceUrl || null
    };

    mockPriceIntelligence.push(record);

    return {
      ...record,
      product_sku: productSku,
      competitor_name: competitorName
    };
  }

  async getPriceHistory(productId, days = 30) {
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);

    return mockPriceIntelligence
      .filter(p => p.product_id === productId)
      .filter(p => new Date(p.captured_at) >= fromDate)
      .map(p => ({
        ...p,
        competitor: mockCompetitors.find(c => c.id === p.competitor_id)
      }))
      .sort((a, b) => new Date(b.captured_at) - new Date(a.captured_at));
  }

  async getPriceComparison(productId) {
    const product = mockProducts.find(p => p.id === productId);
    if (!product) {
      throw new Error('Producto no encontrado');
    }

    const competitorPrices = mockPriceIntelligence
      .filter(p => p.product_id === productId)
      .map(p => ({
        ...p,
        competitor: mockCompetitors.find(c => c.id === p.competitor_id)
      }))
      .sort((a, b) => new Date(b.captured_at) - new Date(a.captured_at));

    const latestByCompetitor = {};
    for (const price of competitorPrices) {
      const compId = price.competitor_id;
      if (!latestByCompetitor[compId]) {
        latestByCompetitor[compId] = price;
      }
    }

    return {
      product,
      competitors: Object.values(latestByCompetitor)
    };
  }

  // Métodos adicionales para la UI
  getAllProducts() {
    return mockProducts;
  }

  getAllCompetitors() {
    return mockCompetitors;
  }

  getAllPrices() {
    return mockPriceIntelligence.map(p => ({
      ...p,
      product: mockProducts.find(prod => prod.id === p.product_id),
      competitor: mockCompetitors.find(c => c.id === p.competitor_id)
    }));
  }
}

module.exports = new IntelligenceServiceMock();
