
import { Sequelize, sql, DataTypes } from './packages/core/src/index.js';

// 创建 Sequelize 实例
const sequelize = new Sequelize('mysql://user:pass@localhost/test');

// 测试 jsonTable 函数的类型
const jsonTableExpr = sql.jsonTable({
  jsonExpr: sql.literal('[{"id": 1, "name": "Alice"}, {"id": 2, "name": "Bob"}]'),
  path: '$[*]',
  columns: [
    { name: 'id', type: 'INT UNSIGNED' },
    { name: 'name', type: 'VARCHAR(255)' }
  ],
  alias: 'json_data'
});

console.log('TypeScript 类型检查通过！');
