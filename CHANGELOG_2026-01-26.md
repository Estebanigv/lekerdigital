# LEKER - Changelog 26 Enero 2026

## Cambios Realizados

### 1. Dashboard Reorganizado
- **Layout de 3 columnas**: Leyenda | Ejecutivos | Comparativo de Competencia
- **Panel Ejecutivos**: Muestra los primeros 4 ejecutivos visibles directamente
- **Enlace "Ver todos los ejecutivos"**: Navega a Rutas y Mapa
- **Cajas redimensionables**: Las tarjetas se pueden redimensionar arrastrando las esquinas
- **Persistencia de navegación**: Al refrescar la página, vuelve al tab donde estabas (guardado en localStorage)

### 2. Rutas y Mapa
- **Panel "Ruta Activa"**: Muestra información cuando un ejecutivo tiene ruta activa
  - Vehículo asignado
  - Hora de inicio
  - Kilometraje inicial
  - Cantidad de clientes
- **Métricas de ruta**:
  - Km Estimados (distancia calculada entre clientes)
  - Duración Estimada (tiempo de viaje + 15 min por cliente)
  - Costo Bencina (basado en eficiencia del vehículo y $1.200/litro)
- **Botón "Ver en Mapa"**: Muestra la ruta en el mapa
- **Mapa corregido**: CSS arreglado para que ocupe la altura completa de la tarjeta
- **Toast notifications**: Al iniciar día muestra notificación en lugar de JSON

### 3. Navegación
- Renombrado "Datos Base" → "Base de Datos"

### 4. Comparativo de Competencia
- Competidores configurados: LEKER (base), DVP, SODIMAC, PRODALAM, IMPERIAL, BOLD
- Colores planos asignados a cada competidor
- Resumen en dashboard con productos, fuentes y precio promedio

---

## Datos de Prueba Creados

### Ejecutivo: D.TARICCO
- **Email**: dtaricco@leker.cl
- **Ruta activa**: Sí (creada 27-01-2026)
- **Vehículo**: HJKL-45 (Fiat Fiorino 2024)
- **Km inicial**: 50,000

### Clientes Asignados (5 con coordenadas GPS):
1. ABEL ANTONIO FUENTES ACEVEDO - San Antonio (-33.61, -71.61)
2. ABRAHAM CASTILLO FALCON - Parral (-36.14, -71.83)
3. ACENOR ACEROS DEL NORTE S.A. - Cerrillos (-33.48, -70.70)
4. ACEROS GAET SPA - San Felipe (-32.74, -70.73)
5. ACERTECH SPA - Maipú (-33.53, -70.74)

---

## Pendiente para Siguiente Sesión

### 1. Visualización de Rutas en Mapa
- [ ] Verificar por qué las métricas muestran 0 km (posible problema con carga de datos)
- [ ] Revisar consola del navegador para debug
- [ ] Asegurar que los clientes con GPS se muestren en el mapa

### 2. Costo por Trayecto
- [ ] Calcular y mostrar costo de combustible por ruta
- [ ] El ejecutivo debe poder ver su ruta asignada con:
  - Mapa con los puntos de visita
  - Distancia total del recorrido
  - Tiempo estimado
  - Costo de bencina estimado

### 3. Vista del Ejecutivo
- [ ] Crear vista específica para que el ejecutivo vea su ruta del día
- [ ] Mostrar lista de clientes a visitar en orden
- [ ] Navegación entre puntos

---

## Servidor

```bash
# Puerto 3000 (si está libre)
node -r dotenv/config src/server.js

# Puerto alternativo 3001
PORT=3001 node -r dotenv/config src/server.js
```

**URL**: http://localhost:3001

---

## Archivos Modificados
- `src/public/index.html` - Dashboard, rutas, navegación
- `src/modules/market-intelligence/intelligence.service.js` - Comparativo
- `src/app.js` - Endpoints de comparativo
- `sql/create_competitor_comparison.sql` - Tablas de comparativo
