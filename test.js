const { Sequelize, DataTypes, Op, col } = require('./packages/core/lib/index.js');
const sequelize = new Sequelize('sqlite::memory:');

const User = sequelize.define('User', {
  data: DataTypes.JSON
});

async function test() {
  const sql = sequelize.dialect.queryGenerator.selectQuery('Users', {
    where: {
      'data.nested.property': 1,
      'data.array[0]': 2,
      'data[1].value': 3,
      [Op.and]: [
        { 'data.test': 4 }
      ]
    },
    model: User
  }, User);
  console.log(sql);
}

test().catch(console.error);
