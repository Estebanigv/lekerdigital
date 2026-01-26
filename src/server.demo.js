const app = require('./app.demo');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║          LEKER Backend - MODO DEMOSTRACIÓN                ║
╠═══════════════════════════════════════════════════════════╣
║                                                           ║
║   Interfaz Web:  http://localhost:${PORT}                    ║
║                                                           ║
║   Los datos son simulados y se reinician al cerrar.       ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
  `);
});
