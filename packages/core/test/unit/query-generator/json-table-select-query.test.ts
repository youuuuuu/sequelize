import type {
  CreationOptional,
  InferAttributes,
  InferCreationAttributes,
  Model,
} from '@sequelize/core';
import { DataTypes, sql } from '@sequelize/core';
import { _validateIncludedElements } from '@sequelize/core/_non-semver-use-at-your-own-risk_/model-internals.js';
import { beforeAll2, expectsql, getTestDialect, sequelize } from '../../support';

const dialectName = getTestDialect();

describe('QueryGenerator#selectQuery with JSON_TABLE', () => {
  const queryGenerator = sequelize.queryGenerator;

  const vars = beforeAll2(() => {
    interface TUser extends Model<InferAttributes<TUser>, InferCreationAttributes<TUser>> {
      id: CreationOptional<number>;
      metadata: string;
    }

    const User = sequelize.define<TUser>(
      'User',
      {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },
        metadata: DataTypes.JSON,
      },
      { timestamps: false },
    );

    interface TProject extends Model<InferAttributes<TProject>, InferCreationAttributes<TProject>> {
      id: CreationOptional<number>;
    }

    const Project = sequelize.define<TProject>(
      'Project',
      {
        id: {
          type: DataTypes.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
        },
      },
      { timestamps: false },
    );

    User.hasMany(Project, { as: 'projects' });
    Project.belongsTo(User, { as: 'owner' });

    return { User, Project };
  });

  it('supports JSON_TABLE expressions in select, where, and include queries', () => {
    const { User } = vars;
    const rolesTable = sql.jsonTable(
      sql.attribute('metadata'),
      '$.roles[*]',
      [{ kind: 'path', name: 'role', sqlType: DataTypes.STRING(32), path: '$' }],
      { alias: 'roles' },
    );
    const roleColumn = sql`${sql.identifier('roles')}.${sql.identifier('role')}`;

    expectsql(
      () =>
        queryGenerator.selectQuery(
          User.table,
          {
            model: User,
            attributes: [
              'id',
              [sql`(SELECT COUNT(*) FROM ${rolesTable} WHERE ${roleColumn} IS NOT NULL)`, 'roleCount'],
            ],
            include: _validateIncludedElements({
              model: User,
              include: [{ association: User.associations.projects, attributes: [] }],
            }).include,
            where: sql`EXISTS (SELECT 1 FROM ${rolesTable} WHERE ${roleColumn} = 'admin')`,
          },
          User,
        ),
      {
        default: new Error(`Function JsonTable is not supported by ${dialectName}.`),
        mysql:
          "SELECT `User`.`id`, (SELECT COUNT(*) FROM JSON_TABLE(`User`.`metadata`, '$.roles[*]' COLUMNS (`role` VARCHAR(32) PATH '$')) AS `roles` WHERE `roles`.`role` IS NOT NULL) AS `roleCount` FROM `Users` AS `User` LEFT OUTER JOIN `Projects` AS `projects` ON `User`.`id` = `projects`.`ownerId` WHERE EXISTS (SELECT 1 FROM JSON_TABLE(`User`.`metadata`, '$.roles[*]' COLUMNS (`role` VARCHAR(32) PATH '$')) AS `roles` WHERE `roles`.`role` = 'admin');",
      },
    );
  });
});
