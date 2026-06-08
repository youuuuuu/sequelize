import { DataTypes, Model } from '@sequelize/core';
import { Attribute } from '@sequelize/core/decorators-legacy';
import { SqliteDialect } from '@sequelize/sqlite3';
import { expect } from 'chai';
import { createSequelizeInstance } from './dev/sscce-helpers';

// 测试模型1：单个唯一索引
class User extends Model {
  @Attribute({
    type: DataTypes.STRING,
    allowNull: false,
    unique: true, // 单个唯一索引
  })
  declare username: string;

  @Attribute({
    type: DataTypes.STRING,
    allowNull: false,
  })
  declare name: string;
}

// 测试模型2：复合唯一索引
class Product extends Model {
  @Attribute({
    type: DataTypes.STRING,
    allowNull: false,
  })
  declare sku: string;

  @Attribute({
    type: DataTypes.STRING,
    allowNull: false,
  })
  declare category: string;
}

const sequelize = createSequelizeInstance({
  dialect: SqliteDialect,
  benchmark: true,
  models: [User, Product],
  paranoid: true, // 启用软删除
});

// 为 Product 模型添加复合唯一索引
Product.addIndex(['sku', 'category'], { unique: true });

(async () => {
  try {
    await sequelize.sync({ force: true });

    console.log('===== 测试1：单个唯一索引 =====');
    // 1. 创建用户1
    const user1 = await User.create({
      username: 'testuser',
      name: 'Test User 1',
    });
    console.log('用户1创建成功:', user1.toJSON());

    // 2. 软删除用户1
    await user1.destroy();
    console.log('用户1软删除成功');

    // 3. 尝试创建具有相同 username 的用户2
    // 这在我们的修复之前会失败，因为唯一约束冲突
    const user2 = await User.create({
      username: 'testuser',
      name: 'Test User 2',
    });
    console.log('用户2创建成功:', user2.toJSON());

    // 4. 验证查找结果（默认应该只找到未删除的用户2）
    const findAllResult = await User.findAll();
    console.log('User.findAll() 结果:', findAllResult.length, '条');
    expect(findAllResult.length).to.equal(1);
    expect(findAllResult[0].username).to.equal('testuser');
    expect(findAllResult[0].name).to.equal('Test User 2');

    // 5. 验证包含已删除记录的查找
    const findAllParanoidFalse = await User.findAll({ paranoid: false });
    console.log('User.findAll({ paranoid: false }) 结果:', findAllParanoidFalse.length, '条');
    expect(findAllParanoidFalse.length).to.equal(2);

    console.log('\n===== 测试2：复合唯一索引 =====');
    // 1. 创建产品1
    const product1 = await Product.create({
      sku: 'ABC123',
      category: 'Electronics',
    });
    console.log('产品1创建成功:', product1.toJSON());

    // 2. 软删除产品1
    await product1.destroy();
    console.log('产品1软删除成功');

    // 3. 尝试创建具有相同 sku 和 category 的产品2
    const product2 = await Product.create({
      sku: 'ABC123',
      category: 'Electronics',
    });
    console.log('产品2创建成功:', product2.toJSON());

    // 4. 验证查找结果
    const productFindAll = await Product.findAll();
    console.log('Product.findAll() 结果:', productFindAll.length, '条');
    expect(productFindAll.length).to.equal(1);
    expect(productFindAll[0].sku).to.equal('ABC123');
    expect(productFindAll[0].category).to.equal('Electronics');

    console.log('\n===== 测试3：upsert 测试 =====');
    // 测试 upsert 功能
    const [user3, created3] = await User.upsert({
      username: 'testuser',
      name: 'Test User 3',
    });
    console.log('upsert 结果: created =', created3);
    console.log('upsert 用户:', user3.toJSON());
    // 应该是更新，因为存在未删除的记录
    expect(created3).to.be.false;

    console.log('\n✅ 所有测试通过！');
  } catch (error) {
    console.error('❌ 测试失败:', error);
  } finally {
    await sequelize.close();
  }
})();
