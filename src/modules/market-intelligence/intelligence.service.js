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

  async upsertProducts(products) {
    const results = { inserted: 0, updated: 0, errors: [] };

    for (const product of products) {
      const productData = {
        sku: product.sku || product.codigo,
        name: product.name || product.nombre,
        description: product.description || product.descripcion,
        base_price: parseFloat(product.base_price || product.precio || 0),
        base_cost: parseFloat(product.base_cost || product.costo || 0),
        category: product.category || product.categoria
      };

      const { data, error } = await supabase
        .from('products')
        .upsert(productData, {
          onConflict: 'sku',
          ignoreDuplicates: false
        })
        .select()
        .single();

      if (error) {
        results.errors.push({ sku: productData.sku, error: error.message });
      } else {
        results.inserted++;
      }
    }

    return results;
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

  // =============================================
  // COMPARATIVO DE COMPETENCIA (n8n workflow)
  // =============================================

  /**
   * Guarda datos del comparativo desde n8n
   * @param {Array} items - Array de productos scrapeados
   * @returns {Object} - Resultados del procesamiento
   */
  async saveCompetitorComparison(items) {
    const results = { inserted: 0, errors: [] };

    for (const item of items) {
      try {
        const record = {
          fecha: item.fecha || new Date().toISOString().split('T')[0],
          hora: item.hora || new Date().toTimeString().split(' ')[0],
          fuente: item.fuente || item.source || 'DESCONOCIDO',
          sku: item.sku || item.codigo || null,
          nombre: item.nombre || item.name || item.producto,
          tipo: item.tipo || item.type || this.detectProductType(item.nombre || item.name),
          espesor: item.espesor || item.thickness || this.detectThickness(item.nombre || item.name),
          precio_neto: parseInt(item.precio_neto || item.precio || item.price || 0),
          precio_anterior: parseInt(item.precio_anterior || item.old_price || 0) || null,
          url: item.url || item.link || null,
          stock_status: item.stock_status || item.stock || 'unknown'
        };

        const { error } = await supabase
          .from('competitor_comparison')
          .insert(record);

        if (error) {
          results.errors.push({ item: item.nombre, error: error.message });
        } else {
          results.inserted++;
        }
      } catch (err) {
        results.errors.push({ item: item.nombre || 'unknown', error: err.message });
      }
    }

    return results;
  }

  /**
   * Detecta el tipo de producto desde el nombre
   */
  detectProductType(nombre) {
    if (!nombre) return 'Otro';
    const lower = nombre.toLowerCase();
    if (lower.includes('alveolar')) return 'Alveolar';
    if (lower.includes('sólido') || lower.includes('solido')) return 'Sólido';
    if (lower.includes('corrugado')) return 'Corrugado';
    if (lower.includes('ondulado')) return 'Ondulado';
    if (lower.includes('compacto')) return 'Compacto';
    return 'Otro';
  }

  /**
   * Detecta el espesor desde el nombre
   */
  detectThickness(nombre) {
    if (!nombre) return null;
    const match = nombre.match(/(\d+)\s*mm/i);
    return match ? `${match[1]}mm` : null;
  }

  /**
   * Obtiene el comparativo más reciente por fuente
   */
  async getLatestComparison() {
    const { data, error } = await supabase
      .from('competitor_comparison')
      .select('*')
      .order('scraped_at', { ascending: false })
      .limit(500);

    if (error) throw error;

    // Agrupar por fuente y obtener los más recientes
    const bySource = {};
    for (const item of data || []) {
      if (!bySource[item.fuente]) {
        bySource[item.fuente] = [];
      }
      // Solo agregar si no existe ya este producto para esta fuente
      const exists = bySource[item.fuente].find(p => p.nombre === item.nombre);
      if (!exists) {
        bySource[item.fuente].push(item);
      }
    }

    return bySource;
  }

  /**
   * Obtiene estadísticas del comparativo
   */
  async getComparisonStats() {
    // Primero obtener la fecha del último scraping
    const { data: latestData } = await supabase
      .from('competitor_comparison')
      .select('scraped_at')
      .order('scraped_at', { ascending: false })
      .limit(1);

    if (!latestData || latestData.length === 0) {
      return [];
    }

    // Usar la fecha del último scraping para obtener todos los datos de ese día
    const latestDate = new Date(latestData[0].scraped_at);
    latestDate.setHours(0, 0, 0, 0);

    const { data, error } = await supabase
      .from('competitor_comparison')
      .select('fuente, precio_neto, tipo, scraped_at')
      .gte('scraped_at', latestDate.toISOString())
      .gt('precio_neto', 0);

    if (error) throw error;

    // Calcular estadísticas por fuente
    const stats = {};
    for (const item of data || []) {
      if (!stats[item.fuente]) {
        stats[item.fuente] = {
          fuente: item.fuente,
          total_productos: 0,
          precios: [],
          tipos: {}
        };
      }
      stats[item.fuente].total_productos++;
      stats[item.fuente].precios.push(item.precio_neto);
      stats[item.fuente].tipos[item.tipo] = (stats[item.fuente].tipos[item.tipo] || 0) + 1;
    }

    // Calcular promedios
    return Object.values(stats).map(s => ({
      fuente: s.fuente,
      total_productos: s.total_productos,
      precio_promedio: Math.round(s.precios.reduce((a, b) => a + b, 0) / s.precios.length),
      precio_min: Math.min(...s.precios),
      precio_max: Math.max(...s.precios),
      tipos: s.tipos
    }));
  }

  /**
   * Obtiene histórico de precios por fuente para gráficos
   */
  async getComparisonHistory(days = 30) {
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);

    const { data, error } = await supabase
      .from('competitor_comparison')
      .select('fuente, precio_neto, scraped_at, tipo')
      .gte('scraped_at', fromDate.toISOString())
      .gt('precio_neto', 0)
      .order('scraped_at', { ascending: true });

    if (error) throw error;

    // Agrupar por fecha y fuente
    const history = {};
    for (const item of data || []) {
      const date = item.scraped_at.split('T')[0];
      if (!history[date]) {
        history[date] = {};
      }
      if (!history[date][item.fuente]) {
        history[date][item.fuente] = { precios: [], count: 0 };
      }
      history[date][item.fuente].precios.push(item.precio_neto);
      history[date][item.fuente].count++;
    }

    // Convertir a formato para gráficos
    const result = Object.entries(history).map(([date, sources]) => {
      const entry = { date };
      for (const [fuente, data] of Object.entries(sources)) {
        entry[fuente] = Math.round(data.precios.reduce((a, b) => a + b, 0) / data.precios.length);
        entry[`${fuente}_count`] = data.count;
      }
      return entry;
    });

    return result;
  }

  /**
   * Guarda resumen semanal
   */
  async saveWeeklySummary() {
    // Obtener el lunes de esta semana
    const today = new Date();
    const monday = new Date(today);
    monday.setDate(today.getDate() - today.getDay() + 1);
    const mondayStr = monday.toISOString().split('T')[0];

    // Obtener estadísticas
    const stats = await this.getComparisonStats();

    const results = { inserted: 0, errors: [] };

    for (const stat of stats) {
      const summary = {
        semana: mondayStr,
        fuente: stat.fuente,
        total_productos: stat.total_productos,
        precio_promedio: stat.precio_promedio,
        precio_min: stat.precio_min,
        precio_max: stat.precio_max
      };

      const { error } = await supabase
        .from('competitor_weekly_summary')
        .upsert(summary, { onConflict: 'semana,fuente' });

      if (error) {
        results.errors.push({ fuente: stat.fuente, error: error.message });
      } else {
        results.inserted++;
      }
    }

    return results;
  }
}

module.exports = new IntelligenceService();
