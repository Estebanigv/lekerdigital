-- Actualizar direcciones de inicio (home_address) de todos los vendedores
-- Ejecutar DESPUÉS de add_home_address.sql
-- Las coordenadas se llenarán con el script geocode_vendors.js

UPDATE users SET home_address = 'Calle Nonguen 577, Concepción' WHERE email = 'fbustos@leker.cl';
UPDATE users SET home_address = 'Pasaje Bernardo Leyton Guzmán 3048, Macul' WHERE email = 'ecaceres@leker.cl';
UPDATE users SET home_address = 'Colbún 2333, San Bernardo' WHERE email = 'eibarra@leker.cl';
UPDATE users SET home_address = '13 Oriente B 2890, Talca' WHERE email = 'ycarrero@leker.cl';
UPDATE users SET home_address = 'Pasaje Gamacruz 27, Los Andes' WHERE email = 'jrubilar@leker.cl';
UPDATE users SET home_address = 'Av Ossa 971, La Reina' WHERE email = 'mgarcia@leker.cl';
UPDATE users SET home_address = 'Av. Javiera Carrera 1176, Temuco' WHERE email = 'marroyo@leker.cl';
UPDATE users SET home_address = 'Los Carrera 1658, Concepción' WHERE email = 'dalmerida@leker.cl';
UPDATE users SET home_address = 'Marta Colvin 2000, Puerto Montt' WHERE email = 'msilva@leker.cl';
UPDATE users SET home_address = 'Pasaje 2 404, Parque Industrial, Puerto Montt' WHERE email = 'arehbein@leker.cl';
UPDATE users SET home_address = 'Avenida Argentina 448, Chillán' WHERE email = 'esagredo@leker.cl';
UPDATE users SET home_address = 'Vía Florentina 1839, Puerto Montt' WHERE email = 'lcanepa@leker.cl';
