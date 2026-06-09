import { DataTypes, Model, Op } from '@sequelize/core';
import { Attribute } from '@sequelize/core/decorators-legacy';
import { SqliteDialect } from '@sequelize/sqlite3';
import { createSequelizeInstance } from './dev/sscce-helpers';

class User extends Model {
  @Attribute({
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  })
  declare email: string;

  @Attribute({
    type: DataTypes.STRING,
    allowNull: false,
  })
  declare name: string;

  @Attribute({
    type: DataTypes.DATE,
    allowNull: true,
  })
  declare deletedAt: Date | null;
}

class Product extends Model {
  @Attribute({
    type: DataTypes.STRING,
    allowNull: false,
  })
  declare category: string;

  @Attribute({
    type: DataTypes.STRING,
    allowNull: false,
  })
  declare sku: string;

  @Attribute({
    type: DataTypes.DATE,
    allowNull: true,
  })
  declare deletedAt: Date | null;
}

const sequelize = createSequelizeInstance({
  dialect: SqliteDialect,
  benchmark: true,
  models: [User, Product],
  define: {
    paranoid: true,
  },
});

async function testBasicSoftDelete() {
  console.log('\n=== Test 1: Basic Soft Delete with Unique Constraint ===');
  
  await sequelize.sync({ force: true });

  // Create a user
  const user1 = await User.create({ email: 'test@example.com', name: 'User 1' });
  console.log('Created user 1:', user1.email);

  // Soft delete the user
  await user1.destroy();
  console.log('Soft deleted user 1');

  // Try to create a new user with the same email - should succeed
  try {
    const user2 = await User.create({ email: 'test@example.com', name: 'User 2' });
    console.log('SUCCESS: Created user 2 with same email after soft delete:', user2.email);
  } catch (error: any) {
    console.log('FAILED: Could not create user with same email after soft delete:', error.message);
  }

  // Verify we can still find the soft-deleted user with paranoid: false
  const softDeletedUser = await User.findOne({ where: { email: 'test@example.com' }, paranoid: false });
  console.log('Found soft-deleted user:', softDeletedUser?.name);

  // Verify we only get the non-deleted user by default
  const activeUser = await User.findOne({ where: { email: 'test@example.com' } });
  console.log('Found active user:', activeUser?.name);
}

async function testCompositeUniqueConstraint() {
  console.log('\n=== Test 2: Composite Unique Constraint with Soft Delete ===');
  
  await sequelize.sync({ force: true });

  // Create a product
  const product1 = await Product.create({ category: 'electronics', sku: 'SKU-001' });
  console.log('Created product 1:', product1.category, product1.sku);

  // Soft delete the product
  await product1.destroy();
  console.log('Soft deleted product 1');

  // Try to create a new product with same category+sku - should succeed
  try {
    const product2 = await Product.create({ category: 'electronics', sku: 'SKU-001' });
    console.log('SUCCESS: Created product 2 with same composite key after soft delete:', product2.category, product2.sku);
  } catch (error: any) {
    console.log('FAILED: Could not create product with same composite key after soft delete:', error.message);
  }

  // Verify we can still find the soft-deleted product with paranoid: false
  const softDeletedProduct = await Product.findOne({ 
    where: { category: 'electronics', sku: 'SKU-001' }, 
    paranoid: false 
  });
  console.log('Found soft-deleted product count:', softDeletedProduct ? 'yes' : 'no');

  // Verify we only get the non-deleted product by default
  const activeProduct = await Product.findOne({ where: { category: 'electronics', sku: 'SKU-001' } });
  console.log('Found active product:', activeProduct ? 'yes' : 'no');
}

async function testHardDelete() {
  console.log('\n=== Test 3: Hard Delete Still Works ===');
  
  await sequelize.sync({ force: true });

  // Create a user
  const user1 = await User.create({ email: 'harddelete@example.com', name: 'User to hard delete' });
  console.log('Created user:', user1.email);

  // Hard delete the user
  await user1.destroy({ force: true });
  console.log('Hard deleted user');

  // Try to create a new user with the same email - should succeed
  try {
    const user2 = await User.create({ email: 'harddelete@example.com', name: 'New user after hard delete' });
    console.log('SUCCESS: Created user after hard delete:', user2.email);
  } catch (error: any) {
    console.log('FAILED: Could not create user after hard delete:', error.message);
  }
}

async function testQueryLogic() {
  console.log('\n=== Test 4: Query Logic for Soft Deleted Records ===');
  
  await sequelize.sync({ force: true });

  // Create users
  await User.create({ email: 'active@example.com', name: 'Active User' });
  const softDeletedUser = await User.create({ email: 'deleted@example.com', name: 'Deleted User' });
  await softDeletedUser.destroy();

  // Find all active users (default)
  const activeUsers = await User.findAll();
  console.log('Active users count:', activeUsers.length);
  console.log('Active users:', activeUsers.map(u => u.name));

  // Find all users including soft-deleted
  const allUsers = await User.findAll({ paranoid: false });
  console.log('All users count (including soft-deleted):', allUsers.length);
  console.log('All users:', allUsers.map(u => u.name));

  // Find only soft-deleted users
  const onlySoftDeleted = await User.findAll({ paranoid: false, where: { deletedAt: { [Op.ne]: null } } });
  console.log('Only soft-deleted users count:', onlySoftDeleted.length);
  console.log('Soft-deleted users:', onlySoftDeleted.map(u => u.name));
}

(async () => {
  try {
    await testBasicSoftDelete();
    await testCompositeUniqueConstraint();
    await testHardDelete();
    await testQueryLogic();
    
    console.log('\n=== All tests completed ===');
  } catch (error) {
    console.error('Test failed with error:', error);
  } finally {
    await sequelize.close();
  }
})();
