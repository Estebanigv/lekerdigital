/**
 * n8n Integration Service
 * Interactúa con la API de n8n para gestionar workflows
 */
const https = require('https');

class N8nService {
  constructor() {
    this.apiUrl = process.env.N8N_API_URL || '';
    this.apiKey = process.env.N8N_API_KEY || '';
  }

  getHeaders() {
    return {
      'Content-Type': 'application/json',
      'X-N8N-API-KEY': this.apiKey
    };
  }

  isConfigured() {
    return !!(this.apiUrl && this.apiKey);
  }

  /**
   * Helper para hacer requests HTTPS
   */
  makeRequest(url, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const options = {
        hostname: urlObj.hostname,
        port: 443,
        path: urlObj.pathname + urlObj.search,
        method: method,
        headers: this.getHeaders()
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: JSON.parse(data) });
          } catch (e) {
            resolve({ ok: false, status: res.statusCode, data: data });
          }
        });
      });

      req.on('error', (e) => reject(e));

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  /**
   * Lista todos los workflows
   */
  async listWorkflows() {
    if (!this.isConfigured()) {
      throw new Error('n8n no está configurado');
    }

    const response = await this.makeRequest(`${this.apiUrl}/workflows`);

    if (!response.ok) {
      throw new Error(`Error al obtener workflows: ${response.status}`);
    }

    return response.data;
  }

  /**
   * Obtiene un workflow específico
   */
  async getWorkflow(workflowId) {
    if (!this.isConfigured()) {
      throw new Error('n8n no está configurado');
    }

    const response = await this.makeRequest(`${this.apiUrl}/workflows/${workflowId}`);

    if (!response.ok) {
      throw new Error(`Error al obtener workflow: ${response.status}`);
    }

    return response.data;
  }

  /**
   * Activa un workflow
   */
  async activateWorkflow(workflowId) {
    if (!this.isConfigured()) {
      throw new Error('n8n no está configurado');
    }

    const response = await this.makeRequest(`${this.apiUrl}/workflows/${workflowId}/activate`, 'POST');

    if (!response.ok) {
      throw new Error(`Error al activar workflow: ${response.status}`);
    }

    return response.data;
  }

  /**
   * Desactiva un workflow
   */
  async deactivateWorkflow(workflowId) {
    if (!this.isConfigured()) {
      throw new Error('n8n no está configurado');
    }

    const response = await this.makeRequest(`${this.apiUrl}/workflows/${workflowId}/deactivate`, 'POST');

    if (!response.ok) {
      throw new Error(`Error al desactivar workflow: ${response.status}`);
    }

    return response.data;
  }

  /**
   * Ejecuta un workflow manualmente
   */
  async executeWorkflow(workflowId, data = {}) {
    if (!this.isConfigured()) {
      throw new Error('n8n no está configurado');
    }

    const response = await this.makeRequest(`${this.apiUrl}/workflows/${workflowId}/run`, 'POST', data);

    if (!response.ok) {
      throw new Error(`Error al ejecutar workflow: ${response.status}`);
    }

    return response.data;
  }

  /**
   * Lista las ejecuciones de un workflow
   */
  async listExecutions(workflowId = null, limit = 20) {
    if (!this.isConfigured()) {
      throw new Error('n8n no está configurado');
    }

    let url = `${this.apiUrl}/executions?limit=${limit}`;
    if (workflowId) {
      url += `&workflowId=${workflowId}`;
    }

    const response = await this.makeRequest(url);

    if (!response.ok) {
      throw new Error(`Error al obtener ejecuciones: ${response.status}`);
    }

    return response.data;
  }

  /**
   * Obtiene las credenciales configuradas
   */
  async listCredentials() {
    if (!this.isConfigured()) {
      throw new Error('n8n no está configurado');
    }

    const response = await this.makeRequest(`${this.apiUrl}/credentials`);

    if (!response.ok) {
      throw new Error(`Error al obtener credenciales: ${response.status}`);
    }

    return response.data;
  }

  /**
   * Crea un workflow desde una plantilla
   */
  async createWorkflowFromTemplate(template) {
    if (!this.isConfigured()) {
      throw new Error('n8n no está configurado');
    }

    const response = await this.makeRequest(`${this.apiUrl}/workflows`, 'POST', template);

    if (!response.ok) {
      throw new Error(`Error al crear workflow: ${response.status}`);
    }

    return response.data;
  }

  /**
   * Plantillas de workflows predefinidos para LEKER
   */
  getWorkflowTemplates() {
    return {
      daily_report: {
        name: 'LEKER - Reporte Diario',
        description: 'Envía un reporte diario de rutas por email',
        nodes: [
          {
            type: 'n8n-nodes-base.scheduleTrigger',
            position: [250, 300],
            parameters: {
              rule: { interval: [{ field: 'hours', hour: 18 }] }
            }
          },
          {
            type: 'n8n-nodes-base.httpRequest',
            position: [450, 300],
            parameters: {
              url: '={{$env.LEKER_API_URL}}/api/reports/daily-routes',
              method: 'GET'
            }
          }
        ]
      },
      price_alert: {
        name: 'LEKER - Alerta de Precios',
        description: 'Notifica cuando hay cambios significativos en precios de competencia',
        nodes: []
      },
      whatsapp_notification: {
        name: 'LEKER - Notificación WhatsApp',
        description: 'Envía notificaciones por WhatsApp cuando se completa una ruta',
        nodes: []
      }
    };
  }

  /**
   * Verifica la conexión con n8n
   */
  async testConnection() {
    if (!this.isConfigured()) {
      return { success: false, error: 'n8n no está configurado' };
    }

    try {
      const response = await this.makeRequest(`${this.apiUrl}/workflows?limit=1`);

      if (response.ok) {
        return { success: true, message: 'Conexión exitosa con n8n' };
      } else {
        return { success: false, error: `Error ${response.status}` };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Actualiza la configuración en runtime
   */
  updateConfig(apiUrl, apiKey) {
    if (apiUrl) this.apiUrl = apiUrl;
    if (apiKey) this.apiKey = apiKey;
  }
}

module.exports = new N8nService();
