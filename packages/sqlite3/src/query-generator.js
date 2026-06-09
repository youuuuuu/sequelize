'use strict';

import { ParameterStyle } from '@sequelize/core';
import {
  ADD_COLUMN_QUERY_SUPPORTABLE_OPTIONS,
  CREATE_TABLE_QUERY_SUPPORTABLE_OPTIONS,
} from '@sequelize/core/_non-semver-use-at-your-own-risk_/abstract-dialect/query-generator.js';
import { rejectInvalidOptions } from '@sequelize/core/_non-semver-use-at-your-own-risk_/utils/check.js';
import { removeNullishValuesFromHash } from '@sequelize/core/_non-semver-use-at-your-own-risk_/utils/format.js';
import { EMPTY_SET } from '@sequelize/core/_non-semver-use-at-your-own-risk_/utils/object.js';
import { defaultValueSchemable } from '@sequelize/core/_non-semver-use-at-your-own-risk_/utils/query-builder-utils.js';
import { createBindParamGenerator } from '@sequelize/core/_non-semver-use-at-your-own-risk_/utils/sql.js';
import { generateIndexName } from '@sequelize/core/_non-semver-use-at-your-own-risk_/utils/string.js';
import { pojo } from '@sequelize/utils';
import defaults from 'lodash/defaults';
import each from 'lodash/each';
import isObject from 'lodash/isObject';
import { SqliteQueryGeneratorTypeScript } from './query-generator-typescript.internal.js';

export class SqliteQueryGenerator extends SqliteQueryGeneratorTypeScript {
  createTableQuery(tableName, attributes, options) {
    if (options) {
      rejectInvalidOptions(
        'createTableQuery',
        this.dialect,
        CREATE_TABLE_QUERY_SUPPORTABLE_OPTIONS,
        EMPTY_SET,
        options,
      );
    }

    options ||= {};

    const primaryKeys = [];
    const needsMultiplePrimaryKeys =
      Object.values(attributes).filter(definition => definition.includes('PRIMARY KEY')).length > 1;
    const attrArray = [];

    for (const attr in attributes) {
      if (Object.hasOwn(attributes, attr)) {
        const dataType = attributes[attr];
        const containsAutoIncrement = dataType.includes('AUTOINCREMENT');

        let dataTypeString = dataType;
        if (dataType.includes('PRIMARY KEY')) {
          if (dataType.includes('INT')) {
            dataTypeString = containsAutoIncrement
              ? 'INTEGER PRIMARY KEY AUTOINCREMENT'
              : 'INTEGER PRIMARY KEY';

            if (dataType.includes(' REFERENCES')) {
              dataTypeString += dataType.slice(dataType.indexOf(' REFERENCES'));
            }
          }

          if (needsMultiplePrimaryKeys) {
            primaryKeys.push(attr);
            if (dataType.includes('NOT NULL')) {
              dataTypeString = dataType.replace(' PRIMARY KEY', '');
            } else {
              dataTypeString = dataType.replace('PRIMARY KEY', 'NOT NULL');
            }
          }
        }

        attrArray.push(`${this.quoteIdentifier(attr)} ${dataTypeString}`);
      }
    }

    const table = this.quoteTable(tableName);
    let attrStr = attrArray.join(', ');
    const pkString = primaryKeys.map(pk => this.quoteIdentifier(pk)).join(', ');

    if (pkString.length > 0) {
      attrStr += `, PRIMARY KEY (${pkString})`;
    }

    const sql = `CREATE TABLE IF NOT EXISTS ${table} (${attrStr});`;

    return this.replaceBooleanDefaults(sql);
  }

  generateUniqueIndexQueries(tableName, options) {
    if (!options?.uniqueKeys) {
      return [];
    }

    const table = this.quoteTable(tableName);
    const queries = [];
    const paranoidDeletedAtField = options.paranoidDeletedAtField;

    for (const key of Object.keys(options.uniqueKeys)) {
      const columns = options.uniqueKeys[key];
      if (!columns.customIndex) {
        continue;
      }

      let indexName = typeof key === 'string' ? key : null;
      if (!indexName) {
        indexName = generateIndexName(tableName, columns);
      }

      const fields = columns.fields.map(field => this.quoteIdentifier(field));

      let whereClause = '';
      if (paranoidDeletedAtField) {
        whereClause = ` WHERE ${this.quoteIdentifier(paranoidDeletedAtField)} IS NULL`;
      }

      queries.push(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${this.quoteIdentifier(indexName)} ON ${table} (${fields.join(', ')})${whereClause};`,
      );
    }

    return queries;
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

    const attributes = {};
    attributes[key] = dataType;
    const fields = this.attributesToSQL(attributes, { context: 'addColumn' });
    const attribute = `${this.quoteIdentifier(key)} ${fields[key]}`;

    const sql = `ALTER TABLE ${this.quoteTable(table)} ADD ${attribute};`;

    return this.replaceBooleanDefaults(sql);
  }

  updateQuery(tableName, attrValueHash, where, options, attributes) {
    options ||= {};
    defaults(options, this.options);
    if ('bindParam' in options) {
      throw new Error('The bindParam option has been removed. Use parameterStyle instead.');
    }

    attrValueHash = removeNullishValuesFromHash(attrValueHash, options.omitNull, options);

    const modelAttributeMap = pojo();
    const values = [];
    let suffix = '';
    let bind;
    let bindParam;
    const parameterStyle = options?.parameterStyle ?? ParameterStyle.BIND;

    if (parameterStyle === ParameterStyle.BIND) {
      bind = pojo();
      bindParam = createBindParamGenerator(bind);
    }

    if (options.returning) {
      const returnValues = this.generateReturnValues(attributes, options);

      suffix += returnValues.returningFragment;

      // ensure that the return output is properly mapped to model fields.
      options.mapToModel = true;
    }

    if (attributes) {
      each(attributes, (attribute, key) => {
        modelAttributeMap[key] = attribute;
        if (attribute.field) {
          modelAttributeMap[attribute.field] = attribute;
        }
      });
    }

    for (const key in attrValueHash) {
      const value = attrValueHash[key] ?? null;

      const escapedValue = this.escape(value, {
        replacements: options.replacements,
        bindParam,
        type: modelAttributeMap[key]?.type,
        // TODO: model,
      });

      values.push(`${this.quoteIdentifier(key)}=${escapedValue}`);
    }

    let query;
    const whereOptions = { ...options, bindParam };

    if (options.limit) {
      query =
        `UPDATE ${this.quoteTable(tableName)} SET ${values.join(',')} WHERE rowid IN (SELECT rowid FROM ${this.quoteTable(tableName)} ${this.whereQuery(where, whereOptions)} LIMIT ${this.escape(options.limit, undefined, options)})${suffix}`.trim();
    } else {
      query =
        `UPDATE ${this.quoteTable(tableName)} SET ${values.join(',')} ${this.whereQuery(where, whereOptions)}${suffix}`.trim();
    }

    const result = { query };
    if (parameterStyle === ParameterStyle.BIND) {
      result.bind = bind;
    }

    return result;
  }

  attributesToSQL(attributes, options) {
    const result = {};
    for (const name in attributes) {
      const attribute = attributes[name];
      const columnName = attribute.field || attribute.columnName || name;

      if (isObject(attribute)) {
        let sql = attribute.type.toString();

        if (attribute.allowNull === false) {
          sql += ' NOT NULL';
        }

        if (defaultValueSchemable(attribute.defaultValue, this.dialect)) {
          // TODO thoroughly check that DataTypes.NOW will properly
          // get populated on all databases as DEFAULT value
          // i.e. mysql requires: DEFAULT CURRENT_TIMESTAMP
          sql += ` DEFAULT ${this.escape(attribute.defaultValue, { ...options, type: attribute.type })}`;
        }

        if (attribute.unique === true) {
          sql += ' UNIQUE';
        }

        if (attribute.primaryKey) {
          sql += ' PRIMARY KEY';

          if (attribute.autoIncrement) {
            sql += ' AUTOINCREMENT';
          }
        }

        if (attribute.references) {
          const referencesTable = this.quoteTable(attribute.references.table);

          let referencesKey;
          if (attribute.references.key) {
            referencesKey = this.quoteIdentifier(attribute.references.key);
          } else {
            referencesKey = this.quoteIdentifier('id');
          }

          sql += ` REFERENCES ${referencesTable} (${referencesKey})`;

          if (attribute.onDelete) {
            sql += ` ON DELETE ${attribute.onDelete.toUpperCase()}`;
          }

          if (attribute.onUpdate) {
            sql += ` ON UPDATE ${attribute.onUpdate.toUpperCase()}`;
          }
        }

        result[columnName] = sql;
      } else {
        result[columnName] = attribute;
      }
    }

    return result;
  }

  replaceBooleanDefaults(sql) {
    return sql
      .replaceAll(/DEFAULT '?false'?/g, 'DEFAULT 0')
      .replaceAll(/DEFAULT '?true'?/g, 'DEFAULT 1');
  }
}
