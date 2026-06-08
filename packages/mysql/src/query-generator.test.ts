import { DataTypes, Sequelize, sql } from '@sequelize/core';
import { MySqlDialect } from '@sequelize/mysql';
import { expect } from 'chai';

describe('MySqlQueryGenerator#jsonTable', () => {
  function createSequelize(databaseVersion = '8.0.19') {
    return new Sequelize({ dialect: MySqlDialect, databaseVersion });
  }

  it('builds a JSON_TABLE fragment', () => {
    const sequelize = createSequelize();

    const fragment = sequelize.queryGenerator.jsonTable(
      sql.attribute('profile'),
      '$.items[*]',
      [
        { kind: 'ordinality', name: 'rowNumber' },
        {
          kind: 'path',
          name: 'itemId',
          sqlType: DataTypes.INTEGER,
          path: '$.id',
          onEmpty: 'null',
          onError: 'error',
        },
        {
          kind: 'exists',
          name: 'hasDiscount',
          sqlType: DataTypes.INTEGER,
          path: '$.discount',
        },
        {
          kind: 'nested',
          path: '$.tags[*]',
          columns: [{ kind: 'path', name: 'tag', sqlType: DataTypes.STRING(20), path: '$' }],
        },
      ],
      { alias: 'items' },
    );

    expect(fragment).to.equal(
      "JSON_TABLE(`profile`, '$.items[*]' COLUMNS (`rowNumber` FOR ORDINALITY, `itemId` INTEGER PATH '$.id' NULL ON EMPTY ERROR ON ERROR, `hasDiscount` INTEGER EXISTS PATH '$.discount', NESTED PATH '$.tags[*]' COLUMNS (`tag` VARCHAR(20) PATH '$'))) AS `items`",
    );
  });

  it('combines JSON_TABLE with JOIN, WHERE, GROUP BY, and ORDER BY clauses', () => {
    const sequelize = createSequelize();
    const rolesTable = sql.jsonTable(
      sql`${sql.identifier('User')}.${sql.identifier('profile')}`,
      '$.roles[*]',
      [{ kind: 'path', name: 'role', sqlType: DataTypes.STRING(20), path: '$' }],
      { alias: 'roles' },
    );
    const roleColumn = sql`${sql.identifier('roles')}.${sql.identifier('role')}`;

    const query = sequelize.queryGenerator.formatSqlExpression(
      sql`SELECT ${roleColumn} AS ${sql.identifier('role')}, COUNT(*) AS ${sql.identifier('count')} FROM ${sql.identifier('Users')} AS ${sql.identifier('User')} JOIN ${rolesTable} ON TRUE WHERE ${roleColumn} IS NOT NULL GROUP BY ${roleColumn} ORDER BY ${roleColumn}`,
    );

    expect(query).to.equal(
      "SELECT `roles`.`role` AS `role`, COUNT(*) AS `count` FROM `Users` AS `User` JOIN JSON_TABLE(`User`.`profile`, '$.roles[*]' COLUMNS (`role` VARCHAR(20) PATH '$')) AS `roles` ON TRUE WHERE `roles`.`role` IS NOT NULL GROUP BY `roles`.`role` ORDER BY `roles`.`role`",
    );
  });

  it('throws a clear error on MySQL versions older than 8.0.4', () => {
    const sequelize = createSequelize('8.0.3');

    expect(() =>
      sequelize.queryGenerator.jsonTable(
        sql.attribute('profile'),
        '$.items[*]',
        [{ kind: 'path', name: 'itemId', sqlType: DataTypes.INTEGER, path: '$.id' }],
        { alias: 'items' },
      ),
    ).to.throw('JSON_TABLE requires MySQL 8.0.4 or newer, but the current database version is 8.0.3.');
  });

  it('declares JSON_TABLE support in the dialect', () => {
    const sequelize = createSequelize();

    expect(sequelize.dialect.supports.jsonTable).to.equal(true);
  });
});
