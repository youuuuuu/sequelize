const { Sequelize, DataTypes } = require('./packages/core');
const { SqliteDialect } = require('./packages/sqlite3');

async function runTests() {
  const sequelize = new Sequelize({
    dialect: SqliteDialect,
    storage: ':memory:',
    logging: console.log,
  });

  // Test 1: Basic soft delete with unique constraint
  console.log('\n=== Test 1: Basic Soft Delete with Unique Constraint ===');
  
  const User = sequelize.define('User', {
    email: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
  }, {
    paranoid: true,
    timestamps: true,
  });

  await sequelize.sync({ force: true });

  // Create a user
  const user1 = await User.create({ email: 'test@example.com', name: 'User 1' });
  console.log('✓ Created user 1:', user1.email);

  // Soft delete the user
  await user1.destroy();
  console.log('✓ Soft deleted user 1');

  // Try to create a new user with the same email
  try {
    const user2 = await User.create({ email: 'test@example.com', name: 'User 2' });
    console.log('✓ SUCCESS: Created user 2 with same email after soft delete');
  } catch (error) {
    console.log('✗ FAILED:', error.message);
  }

  // Verify soft-deleted user is not returned by default
  const activeUsers = await User.findAll();
  console.log('✓ Active users count:', activeUsers.length);

  // Verify soft-deleted user can be found with paranoid: false
  const allUsers = await User.findAll({ paranoid: false });
  console.log('✓ All users count (including soft-deleted):', allUsers.length);

  // Test 2: Composite unique constraint with soft delete
  console.log('\n=== Test 2: Composite Unique Constraint with Soft Delete ===');
  
  const Product = sequelize.define('Product', {
    category: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    sku: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
  }, {
    paranoid: true,
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ['category', 'sku'],
      },
    ],
  });

  await sequelize.sync({ force: true });

  // Create a product
  const product1 = await Product.create({ category: 'electronics', sku: 'SKU-001', name: 'Product 1' });
  console.log('✓ Created product 1:', product1.category, product1.sku);

  // Soft delete the product
  await product1.destroy();
  console.log('✓ Soft deleted product 1');

  // Try to create a new product with same category+sku
  try {
    const product2 = await Product.create({ category: 'electronics', sku: 'SKU-001', name: 'Product 2' });
    console.log('✓ SUCCESS: Created product 2 with same composite key after soft delete');
  } catch (error) {
    console.log('✗ FAILED:', error.message);
  }

  // Test 3: Hard delete still works
  console.log('\n=== Test 3: Hard Delete Still Works ===');
  
  await sequelize.sync({ force: true });

  const user3 = await User.create({ email: 'harddelete@example.com', name: 'User to hard delete' });
  console.log('✓ Created user:', user3.email);

  // Hard delete
  await user3.destroy({ force: true });
  console.log('✓ Hard deleted user');

  // Try to create a new user with the same email
  try {
    const user4 = await User.create({ email: 'harddelete@example.com', name: 'New user after hard delete' });
    console.log('✓ SUCCESS: Created user after hard delete');
  } catch (error) {
    console.log('✗ FAILED:', error.message);
  }

  // Test 4: Query logic for soft deleted records
  console.log('\n=== Test 4: Query Logic for Soft Deleted Records ===');
  
  await sequelize.sync({ force: true });

  await User.create({ email: 'active@example.com', name: 'Active User' });
  const softDeletedUser = await User.create({ email: 'deleted@example.com', name: 'Deleted User' });
  await softDeletedUser.destroy();

  // Find all active users (default)
  const activeUsers2 = await User.findAll();
  console.log('✓ Active users count:', activeUsers2.length);
  console.log('✓ Active users:', activeUsers2.map(u => u.name).join(', '));

  // Find all users including soft-deleted
  const allUsers2 = await User.findAll({ paranoid: false });
  console.log('✓ All users count (including soft-deleted):', allUsers2.length);
  console.log('✓ All users:', allUsers2.map(u => u.name).join(', '));

  // Find only soft-deleted users
  const onlySoftDeleted = await User.findAll({ 
    paranoid: false, 
    where: { deletedAt: { [Sequelize.Op.ne]: null } } 
  });
  console.log('✓ Only soft-deleted users count:', onlySoftDeleted.length);
  console.log('✓ Soft-deleted users:', onlySoftDeleted.map(u => u.name).join(', '));

  console.log('\n=== All tests completed ===');
  
  await sequelize.close();
}

runTests().catch(error => {
  console.error('Test failed with error:', error);
  process.exit(1);
});
