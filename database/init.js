import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function initDatabase() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = await fs.readFile(schemaPath, 'utf8');

  console.log(`Conectando a MySQL en ${process.env.DB_HOST}:${process.env.DB_PORT || 3306} (${process.env.DB_NAME})...`);

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: true,
    connectTimeout: 15000,
  });

  try {
    await connection.query(sql);
    const [tables] = await connection.query('SHOW TABLES');
    console.log('Esquema aplicado correctamente. Tablas disponibles:');
    for (const row of tables) {
      const tableName = Object.values(row)[0];
      console.log(`  - ${tableName}`);
    }
  } finally {
    await connection.end();
  }
}

initDatabase().catch((err) => {
  console.error('Error al inicializar la base de datos:', err.message);
  process.exit(1);
});
