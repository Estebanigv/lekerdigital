require('dotenv').config();

const app = require('./app');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║           LEKER Backend - Sistema de Gestión          ║
╠═══════════════════════════════════════════════════════╣
║  Server running on http://localhost:${PORT}              ║
║  Environment: ${process.env.NODE_ENV || 'development'}                          ║
╚═══════════════════════════════════════════════════════╝

📍 Endpoints disponibles:

  RUTAS Y FLOTA:
  POST /routes/start          - Iniciar día (vendedor)
  POST /routes/checkin        - Registrar visita
  GET  /routes/active/:userId - Obtener ruta activa

  INTELIGENCIA DE MERCADO:
  POST /webhooks/n8n-price-update              - Webhook n8n
  GET  /intelligence/product/:id/history       - Histórico precios
  GET  /intelligence/product/:id/comparison    - Comparativa precios

  HEALTH:
  GET  /health                - Estado del servicio
  `);
});
