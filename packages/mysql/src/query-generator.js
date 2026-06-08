'use strict';

import {
  attributeTypeToSql,
  normalizeDataType,
} from '@sequelize/core/_non-semver-use-at-your-own-risk_/abstract-dialect/data-types-utils.js';
import { ADD_COLUMN_QUERY_SUPPORTABLE_OPTIONS } from '@sequelize/core/_non-semver-use-at-your-own-risk_/abstract-dialect/query-generator.js';
import { BaseSqlExpression } from '@sequelize/core/_non-semver-use-at-your-own-risk_/expression-builders/base-sql-expression.js';
import { rejectInvalidOptions } from '@sequelize/core/_non-semver-use-at-your-own-risk_/utils/check.js';
import { joinSQLFragments } from '@sequelize/core/_non-semver-use-at-your-own-risk_/utils/join-sql-fragments.js';
import { EMPTY_SET } from '@sequelize/core/_non-semver-use-at-your-own-risk_/utils/object.js';
import { defaultValueSchemable } from '@sequelize/core/_non-semver-use-at-your-own-risk_/utils/query-builder-utils.js';
import { inspect } from '@sequelize/utils';
import each from 'lodash/each';
import isPlainObject from 'lodash/isPlainObject';
import { MySqlQueryGeneratorTypeScript } from './query-generator-typescript.internal.js';

const typeWithoutDefault = new Set(['BLOB', 'TEXT', 'GEOMETRY', 'JSON']);
const JSON_TABLE_MINIMUM_VERSION = '8.0.4';

function formatJsonTableSqlType(queryGenerator, sqlType) {
  if (typeof sqlType === 'string') {
    return sqlType;
  }

  return attributeTypeToSql(normalizeDataType(sqlType, queryGenerator.dialect), {
    escape: queryGenerator.escape.bind(queryGenerator),
    dialect: queryGenerator.dialect,
  });
}

function formatJsonTableBehavior(queryGenerator, clause, behavior) {
  if (behavior == null) {
    return '';
  }

  if (behavior === 'null') {
    return `NULL ON ${clause}`;
  }

  if (behavior === 'error') {
    return `ERROR ON ${clause}`;
  }

  return `DEFAULT ${queryGenerator.escape(behavior.default)} ON ${clause}`;
}

function formatJsonTableColumn(queryGenerator, column) {
  if (column.kind === 'ordinality') {
    return `${queryGenerator.quoteIdentifier(column.name)} FOR ORDINALITY`;
  }

  if (column.kind === 'exists') {
    return joinSQLFragments([
      queryGenerator.quoteIdentifier(column.name),
      formatJsonTableSqlType(queryGenerator, column.sqlType),
      'EXISTS PATH',
      queryGenerator.escape(column.path),
    ]);
  }

  if (column.kind === 'nested') {
    if (column.columns.length === 0) {
      throw new Error('JSON_TABLE nested columns require at least one column definition.');
    }

    return joinSQLFragments([
      'NESTED PATH',
      queryGenerator.escape(column.path),
      `COLUMNS (${column.columns.map(nestedColumn => formatJsonTableColumn(queryGenerator, nestedColumn)).join(', ')})`,
    ]);
  }

  return joinSQLFragments([
    queryGenerator.quoteIdentifier(column.name),
    formatJsonTableSqlType(queryGenerator, column.sqlType),
    'PATH',
    queryGenerator.escape(column.path),
    formatJsonTableBehavior(queryGenerator, 'EMPTY', column.onEmpty),
    formatJsonTableBehavior(queryGenerator, 'ERROR', column.onError),
  ]);
}

function parseMysqlVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);

  if (!match) {
    return null;
  }

  return match.slice(1).map(Number);
}

function isMysqlVersionLessThan(version, minimumVersion) {
  const parsedVersion = parseMysqlVersion(version);
  const parsedMinimumVersion = parseMysqlVersion(minimumVersion);

  if (!parsedVersion || !parsedMinimumVersion) {
    return false;
  }

  for (const [index, part] of parsedVersion.entries()) {
    if (part < parsedMinimumVersion[index]) {
      return true;
    }

    if (part > parsedMinimumVersion[index]) {
      return false;
    }
  }

  return false;
}

function assertJsonTableSupported(queryGenerator) {
  if (!queryGenerator.dialect.supports.jsonTable) {
    throw new Error(`JSON_TABLE is not supported in ${queryGenerator.dialect.name}.`);
  }

  const databaseVersion = queryGenerator.sequelize.getDatabaseVersionIfExist();

  if (databaseVersion && isMysqlVersionLessThan(databaseVersion, JSON_TABLE_MINIMUM_VERSION)) {
    throw new Error(
      `JSON_TABLE requires MySQL ${JSON_TABLE_MINIMUM_VERSION} or newer, but the current database version is ${databaseVersion}.`,
    );
  }
}

export class MySqlQueryGenerator extends MySqlQueryGeneratorTypeScript {
  createTableQuery(tableName, attributes, options) {
    options = {
      engine: 'InnoDB',
      charset: null,
      rowFormat: null,
      ...options,
    };

    const primaryKeys = [];
    const foreignKeys = {};
    const attrStr = [];

    for (const attr in attributes) {
      if (!Object.hasOwn(attributes, attr)) {
        continue;
      }

      const dataType = attributes[attr];
      let match;

      if (dataType.includes('PRIMARY KEY')) {
        primaryKeys.push(attr);

        if (dataType.includes('REFERENCES')) {
          // MySQL doesn't support inline REFERENCES declarations: move to the end
          match = dataType.match(/^(.+) (REFERENCES.*)$/);
          attrStr.push(`${this.quoteIdentifier(attr)} ${match[1].replace('PRIMARY KEY', '')}`);
          foreignKeys[attr] = match[2];
        } else {
          attrStr.push(`${this.quoteIdentifier(attr)} ${dataType.replace('PRIMARY KEY', '')}`);
        }
      } else if (dataType.includes('REFERENCES')) {
        // MySQL doesn't support inline REFERENCES declarations: move to the end
        match = dataType.match(/^(.+) (REFERENCES.*)$/);
        attrStr.push(`${this.quoteIdentifier(attr)} ${match[1]}`);
        foreignKeys[attr] = match[2];
      } else {
        attrStr.push(`${this.quoteIdentifier(attr)} ${dataType}`);
      }
    }

    const table = this.quoteTable(tableName);
    let attributesClause = attrStr.join(', ');
    const pkString = primaryKeys.map(pk => this.quoteIdentifier(pk)).join(', ');

    if (options.uniqueKeys) {
      each(options.uniqueKeys, (columns, indexName) => {
        if (typeof indexName !== 'string') {
          indexName = `uniq_${tableName}_${columns.fields.join('_')}`;
        }

        attributesClause += `, UNIQUE ${this.quoteIdentifier(indexName)} (${columns.fields
          .map(field => this.quoteIdentifier(field))
          .join(', ')})`;
      });
    }

    if (pkString.length > 0) {
      attributesClause += `, PRIMARY KEY (${pkString})`;
    }

    for (const fkey in foreignKeys) {
      if (Object.hasOwn(foreignKeys, fkey)) {
        attributesClause += `, FOREIGN KEY (${this.quoteIdentifier(fkey)}) ${foreignKeys[fkey]}`;
      }
    }

    return joinSQLFragments([
      'CREATE TABLE IF NOT EXISTS',
      table,
      `(${attributesClause})`,
      `ENGINE=${options.engine}`,
      options.comment &&
        typeof options.comment === 'string' &&
        `COMMENT ${this.escape(options.comment)}`,
      options.charset && `DEFAULT CHARSET=${options.charset}`,
      options.collate && `COLLATE ${options.collate}`,
      options.initialAutoIncrement && `AUTO_INCREMENT=${options.initialAutoIncrement}`,
      options.rowFormat && `ROW_FORMAT=${options.rowFormat}`,
      ';',
    ]);
  }

  addColumnQuery(table, key, dataType, options) {
    if (options) {
      rejectInvalidOptions(
        'addColumnQuery',
        this.dialect,
        ADD_COLUMN_QUERY_SUPPORTABLE_OPTIONS,
        EMPTY_SET,
        options,
      );
    }

    dataType = {
      ...dataType,
      type: normalizeDataType(dataType.type, this.dialect),
    };

    return joinSQLFragments([
      'ALTER TABLE',
      this.quoteTable(table),
      'ADD',
      this.quoteIdentifier(key),
      this.attributeToSQL(dataType, {
        context: 'addColumn',
        tableName: table,
        foreignKey: key,
      }),
      ';',
    ]);
  }

  changeColumnQuery(tableName, attributes) {
    const attrString = [];
    const constraintString = [];

    for (const attributeName in attributes) {
      let definition = attributes[attributeName];
      if (definition.includes('REFERENCES')) {
        const attrName = this.quoteIdentifier(attributeName);
        definition = definition.replace(/.+?(?=REFERENCES)/, '');
        constraintString.push(`FOREIGN KEY (${attrName}) ${definition}`);
      } else {
        attrString.push(`\`${attributeName}\` \`${attributeName}\` ${definition}`);
      }
    }

    return joinSQLFragments([
      'ALTER TABLE',
      this.quoteTable(tableName),
      attrString.length && `CHANGE ${attrString.join(', ')}`,
      constraintString.length && `ADD ${constraintString.join(', ')}`,
      ';',
    ]);
  }

  renameColumnQuery(tableName, attrBefore, attributes) {
    const attrString = [];

    for (const attrName in attributes) {
      const definition = attributes[attrName];
      attrString.push(`\`${attrBefore}\` \`${attrName}\` ${definition}`);
    }

    return joinSQLFragments([
      'ALTER TABLE',
      this.quoteTable(tableName),
      'CHANGE',
      attrString.join(', '),
      ';',
    ]);
  }

  attributeToSQL(attribute, options) {
    if (!isPlainObject(attribute)) {
      attribute = {
        type: attribute,
      };
    }

    const attributeString = attributeTypeToSql(attribute.type, {
      escape: this.escape.bind(this),
      dialect: this.dialect,
    });
    let template = attributeString;

    if (attribute.allowNull === false) {
      template += ' NOT NULL';
    }

    if (attribute.autoIncrement) {
      template += ' auto_increment';
    }

    // BLOB/TEXT/GEOMETRY/JSON cannot have a default value
    if (
      !typeWithoutDefault.has(attributeString) &&
      attribute.type._binary !== true &&
      defaultValueSchemable(attribute.defaultValue, this.dialect)
    ) {
      const { defaultValue } = attribute;
      const escaped = this.escape(defaultValue);
      // MySQL 8.0.13+ supports expressions as default values if they are wrapped in parentheses
      template += ` DEFAULT ${defaultValue instanceof BaseSqlExpression ? `(${escaped})` : escaped}`;
    }

    if (attribute.unique === true) {
      template += ' UNIQUE';
    }

    if (attribute.primaryKey) {
      template += ' PRIMARY KEY';
    }

    if (attribute.comment) {
      template += ` COMMENT ${this.escape(attribute.comment)}`;
    }

    if (attribute.first) {
      template += ' FIRST';
    }

    if (attribute.after) {
      template += ` AFTER ${this.quoteIdentifier(attribute.after)}`;
    }

    if ((!options || !options.withoutForeignKeyConstraints) && attribute.references) {
      if (options && options.context === 'addColumn' && options.foreignKey) {
        const fkName = this.quoteIdentifier(
          `${this.extractTableDetails(options.tableName).tableName}_${options.foreignKey}_foreign_idx`,
        );

        template += `, ADD CONSTRAINT ${fkName} FOREIGN KEY (${this.quoteIdentifier(options.foreignKey)})`;
      }

      template += ` REFERENCES ${this.quoteTable(attribute.references.table)}`;

      if (attribute.references.key) {
        template += ` (${this.quoteIdentifier(attribute.references.key)})`;
      } else {
        template += ` (${this.quoteIdentifier('id')})`;
      }

      if (attribute.onDelete) {
        template += ` ON DELETE ${attribute.onDelete.toUpperCase()}`;
      }

      if (attribute.onUpdate) {
        template += ` ON UPDATE ${attribute.onUpdate.toUpperCase()}`;
      }
    }

    return template;
  }

  attributesToSQL(attributes, options) {
    const result = {};

    for (const key in attributes) {
      const attribute = attributes[key];
      result[attribute.field || key] = this.attributeToSQL(attribute, options);
    }

    return result;
  }

  jsonTable(expression, path, columns, options, escapeOptions) {
    assertJsonTableSupported(this);

    if (!options?.alias) {
      throw new Error('JSON_TABLE requires an alias.');
    }

    if (columns.length === 0) {
      throw new Error('JSON_TABLE requires at least one column definition.');
    }

    return joinSQLFragments([
      `JSON_TABLE(${this.escape(expression, escapeOptions)}, ${this.escape(path)} COLUMNS (${columns.map(column => formatJsonTableColumn(this, column)).join(', ')}))`,
      'AS',
      this.quoteIdentifier(options.alias),
    ]);
  }

  _getBeforeSelectAttributesFragment(options) {
    let fragment = '';

    const MINIMUM_EXECUTION_TIME_VALUE = 0;
    const MAXIMUM_EXECUTION_TIME_VALUE = 4_294_967_295;

    if (options.maxExecutionTimeHintMs != null) {
      if (
        Number.isSafeInteger(options.maxExecutionTimeHintMs) &&
        options.maxExecutionTimeHintMs >= MINIMUM_EXECUTION_TIME_VALUE &&
        options.maxExecutionTimeHintMs <= MAXIMUM_EXECUTION_TIME_VALUE
      ) {
        fragment += ` /*+ MAX_EXECUTION_TIME(${options.maxExecutionTimeHintMs}) */`;
      } else {
        throw new Error(
          `maxExecutionTimeMs must be between ${MINIMUM_EXECUTION_TIME_VALUE} and ${MAXIMUM_EXECUTION_TIME_VALUE}, but it is ${inspect(options.maxExecutionTimeHintMs)}`,
        );
      }
    }

    return fragment;
  }
}
