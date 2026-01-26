const { supabase } = require('../../config/database');

class IntelligenceService {
  // =============================================
  // PRODUCTOS
  // =============================================

  async getAllProducts() {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .order('name');

    if (error) throw error;
    return data || [];
  }

  // =============================================
  // COMPETIDORES
  // =============================================

  async getAllCompetitors() {
    const { data, error } = await supabase
      .from('competitors')
      .select('*')
      .order('name');

    if (error) throw error;
    return data || [];
  }

  // =============================================
  // PRECIOS
  // =============================================

  async getAllPrices() {
    const { data, error } = await supabase
      .from('price_intelligence')
      .select(`
        *,
        product:products(id, sku, name, list_price),
        competitor:competitors(id, name)
      `)
      .order('captured_at', { ascending: false })
      .limit(100);

    if (error) throw error;
    return data || [];
  }

  /**
   * Procesa actualizaciones de precios desde n8n
   * Acepta un array de precios o un precio individual
   */
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

  /**
   * Inserta un registro de precio individual
   */
  async insertPriceRecord({ productSku, competitorName, detectedPrice, source, evidenceUrl }) {
    // Buscar o crear producto por SKU
    let product = await this.findProductBySku(productSku);
    if (!product) {
      throw new Error(`Producto con SKU '${productSku}' no encontrado`);
    }

    // Buscar o crear competidor por nombre
    let competitor = await this.findOrCreateCompetitor(competitorName);

    // Insertar registro de precio
    const { data, error } = await supabase
      .from('price_intelligence')
      .insert({
        product_id: product.id,
        competitor_id: competitor.id,
        detected_price: detectedPrice,
        source: source || 'n8n_scraper',
        evidence_url: evidenceUrl || null
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Error al insertar precio: ${error.message}`);
    }

    return {
      ...data,
      product_sku: productSku,
      competitor_name: competitorName
    };
  }

  /**
   * Busca un producto por SKU
   */
  async findProductBySku(sku) {
    const { data, error } = await supabase
      .from('products')
      .select('id, sku, name')
      .eq('sku', sku)
      .single();

    if (error) return null;
    return data;
  }

  /**
   * Busca o crea un competidor por nombre
   */
  async findOrCreateCompetitor(name) {
    // Buscar existente
    const { data: existing } = await supabase
      .from('competitors')
      .select('id, name')
      .eq('name', name)
      .single();

    if (existing) return existing;

    // Crear nuevo
    const { data: created, error } = await supabase
      .from('competitors')
      .insert({ name })
      .select()
      .single();

    if (error) {
      throw new Error(`Error al crear competidor: ${error.message}`);
    }

    return created;
  }

  /**
   * Obtiene histórico de precios de un producto
   */
  async getPriceHistory(productId, days = 30) {
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);

    const { data, error } = await supabase
      .from('price_intelligence')
      .select(`
        id,
        detected_price,
        captured_at,
        source,
        evidence_url,
        competitor:competitors(id, name)
      `)
      .eq('product_id', productId)
      .gte('captured_at', fromDate.toISOString())
      .order('captured_at', { ascending: false });

    if (error) {
      throw new Error(`Error al obtener histórico: ${error.message}`);
    }

    return data;
  }

  /**
   * Obtiene comparativa de precios actual
   */
  async getPriceComparison(productId) {
    const { data: product, error: productError } = await supabase
      .from('products')
      .select('id, sku, name, list_price, base_cost')
      .eq('id', productId)
      .single();

    if (productError || !product) {
      throw new Error('Producto no encontrado');
    }

    // Obtener último precio de cada competidor
    const { data: competitorPrices, error } = await supabase
      .from('price_intelligence')
      .select(`
        detected_price,
        captured_at,
        competitor:competitors(id, name)
      `)
      .eq('product_id', productId)
      .order('captured_at', { ascending: false });

    if (error) {
      throw new Error(`Error al obtener precios: ${error.message}`);
    }

    // Agrupar por competidor (quedarse con el más reciente)
    const latestByCompetitor = {};
    for (const price of competitorPrices) {
      const compId = price.competitor.id;
      if (!latestByCompetitor[compId]) {
        latestByCompetitor[compId] = price;
      }
    }

    return {
      product,
      competitors: Object.values(latestByCompetitor)
    };
  }
}

module.exports = new IntelligenceService();
