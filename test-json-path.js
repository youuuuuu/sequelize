
// 简单的测试脚本来验证我们的修改
import { Sequelize } from './packages/core/src/index.js';
import { Op, col, fn } from './packages/core/src/index.js';
import { PostgresDialect } from './packages/postgres/src/index.js';
import { MysqlDialect } from './packages/mysql/src/index.js';
import { SqliteDialect } from './packages/sqlite3/src/index.js';

console.log('测试 JSON 路径查询支持...\n');

// 测试 Postgres
console.log('=== 测试 Postgres 方言 ===');
const pgDialect = new PostgresDialect({
  sequelize: null,
});
const pgGenerator = pgDialect.queryGenerator;

// 测试 parseAttributeSyntax 的使用
try {
  const parsed1 = pgGenerator.whereSqlBuilder['#parseAttributeSyntax']('data.items[0].name');
  console.log('解析 data.items[0].name:', parsed1);
} catch (e) {
  console.log('parseAttributeSyntax 测试错误:', e.message);
}

// 测试 JsonPath 格式化
try {
  const { Attribute, JsonPath } = await import('./packages/core/src/index.js');
  const jsonPath1 = new JsonPath(new Attribute('data'), ['items', 0, 'name']);
  const jsonPath2 = new JsonPath(new Attribute('json'), ['nested', 'key']);
  
  const formatted1 = pgGenerator.formatSqlExpression(jsonPath1);
  const formatted2 = pgGenerator.formatSqlExpression(jsonPath2);
  
  console.log('Postgres 格式化 data.items[0].name:', formatted1);
  console.log('Postgres 格式化 json.nested.key:', formatted2);
} catch (e) {
  console.log('JsonPath 格式化测试错误:', e.message);
}

// 测试 MySQL 方言
console.log('\n=== 测试 MySQL 方言 ===');
try {
  const mysqlDialect = new MysqlDialect({ sequelize: null });
  const mysqlGenerator = mysqlDialect.queryGenerator;
  
  const { Attribute, JsonPath } = await import('./packages/core/src/index.js');
  const jsonPath1 = new JsonPath(new Attribute('data'), ['items', 0, 'name']);
  
  const formatted = mysqlGenerator.formatSqlExpression(jsonPath1);
  console.log('MySQL 格式化 data.items[0].name:', formatted);
} catch (e) {
  console.log('MySQL 测试错误:', e.message);
}

// 测试 SQLite 方言
console.log('\n=== 测试 SQLite 方言 ===');
try {
  const sqliteDialect = new SqliteDialect({ sequelize: null });
  const sqliteGenerator = sqliteDialect.queryGenerator;
  
  const { Attribute, JsonPath } = await import('./packages/core/src/index.js');
  const jsonPath1 = new JsonPath(new Attribute('data'), ['items', 0, 'name']);
  
  const formatted = sqliteGenerator.formatSqlExpression(jsonPath1);
  console.log('SQLite 格式化 data.items[0].name:', formatted);
} catch (e) {
  console.log('SQLite 测试错误:', e.message);
}

console.log('\n=== 测试 Col 与 JSON 路径 ===');
try {
  const testCol = col('data.items[0].name');
  console.log('Col 对象:', testCol);
} catch (e) {
  console.log('Col 测试错误:', e.message);
}

console.log('\n测试完成！');
