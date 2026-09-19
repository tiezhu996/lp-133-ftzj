const mysql = require('mysql2/promise');
const env = require('./src/config/env');

const pool = mysql.createPool({
  host: env.database.host,
  port: env.database.port,
  user: env.database.user,
  password: env.database.password,
  database: env.database.name,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// 为已存在的数据库补充取消闭环所需字段（幂等，不影响现有启动方式）
const ensureCancelColumns = async () => {
  const [columns] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'orders'`,
    [env.database.name]
  );
  const existing = new Set(columns.map((column) => column.COLUMN_NAME));

  const additions = [
    'ADD COLUMN cancel_reason VARCHAR(500) COMMENT \'取消原因\' AFTER end_time',
    'ADD COLUMN cancelled_by INT COMMENT \'取消人ID(用户或志愿者)\' AFTER cancel_reason',
    'ADD COLUMN cancelled_at DATETIME COMMENT \'取消时间\' AFTER cancelled_by',
  ];

  const missing = additions.filter((sql) => {
    const column = sql.match(/ADD COLUMN (\w+)/)[1];
    return !existing.has(column);
  });

  if (missing.length > 0) {
    await pool.query(`ALTER TABLE orders ${missing.join(', ')}`);
  }
};

ensureCancelColumns().catch((err) => {
  console.error('订单表取消字段检查失败:', err.message);
});

module.exports = pool;
