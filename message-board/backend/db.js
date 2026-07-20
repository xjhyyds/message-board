const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'app_user',
  password: process.env.DB_PASSWORD || 'app_password',
  database: process.env.DB_NAME || 'messages_db',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
});

pool.on('connection', function (conn) {
  conn.query("SET NAMES utf8mb4");
});

module.exports = pool;
