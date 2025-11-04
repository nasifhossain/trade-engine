const mysql = require('mysql2/promise');

/**
 * Database Forge - Node.js equivalent of CodeIgniter's DB Forge
 * Provides flexible table creation and migration capabilities
 */
class DBForge {
  constructor(pool = null) {
    this.pool = pool;
    this.fields = {};
    this.keys = [];
    this.primary_keys = [];
    this.engine = 'InnoDB';
    this.charset = 'utf8mb4';
    this.collate = 'utf8mb4_unicode_ci';
  }

  /**
   * Create database connection pool from environment
   */
  static createPoolFromEnv() {
    // Check if running inside Docker or from host machine
    const isDocker = process.env.MYSQL_HOST === 'mysql';
    const host = isDocker ? process.env.MYSQL_HOST : 'localhost';
    const port = isDocker ? 3306 : (process.env.HOST_MYSQL_PORT || 3307);
    
    const config = {
      host: host,
      port: parseInt(port),
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || 'rootpassword',
      database: process.env.MYSQL_DATABASE || 'twocents_db',
      waitForConnections: true,
      connectionLimit: 50, // Increased for high throughput (2000 RPS target)
      queueLimit: 0
    };
    
    console.log(`Creating MySQL connection pool: ${config.host}:${config.port}/${config.database}`);
    return mysql.createPool(config);
  }

  /**
   * Add field definition (similar to CodeIgniter's add_field)
   * @param {object|string} field - Field definition object or field name
   * @returns {DBForge} - Returns this for chaining
   */
  add_field(field) {
    if (typeof field === 'string') {
      // Handle shorthand 'id' field
      if (field === 'id') {
        this.fields.id = {
          type: 'INT',
          constraint: 11,
          unsigned: true,
          auto_increment: true
        };
        this.add_key('id', true);
      } else {
        // Raw SQL field definition
        this.fields[field] = { _literal: true, definition: field };
      }
    } else if (typeof field === 'object') {
      // Merge field definitions
      Object.assign(this.fields, field);
    }
    
    return this;
  }

  /**
   * Add key (index) to table
   * @param {string|array} key - Field name(s) for the key
   * @param {boolean} primary - Whether this is a primary key
   * @returns {DBForge} - Returns this for chaining
   */
  add_key(key, primary = false) {
    if (primary) {
      if (Array.isArray(key)) {
        this.primary_keys = [...this.primary_keys, ...key];
      } else {
        this.primary_keys.push(key);
      }
    } else {
      if (Array.isArray(key)) {
        this.keys = [...this.keys, ...key];
      } else {
        this.keys.push(key);
      }
    }
    
    return this;
  }

  /**
   * Build field SQL from field definition
   * @param {string} fieldName - Name of the field
   * @param {object} fieldDef - Field definition object
   * @returns {string} - MySQL column definition
   */
  _build_field_sql(fieldName, fieldDef) {
    if (fieldDef._literal) {
      return fieldDef.definition;
    }

    let sql = `\`${fieldName}\``;
    
    // Handle type and constraint
    if (fieldDef.type) {
      sql += ` ${fieldDef.type.toUpperCase()}`;
      
      if (fieldDef.constraint !== undefined) {
        if (Array.isArray(fieldDef.constraint)) {
          // For ENUM/SET types
          const values = fieldDef.constraint.map(v => `'${v.replace(/'/g, "''")}'`).join(', ');
          sql += `(${values})`;
        } else {
          // For other constraints like VARCHAR(255), INT(11), DECIMAL(10,2)
          sql += `(${fieldDef.constraint})`;
        }
      }
    }
    
    // Handle unsigned
    if (fieldDef.unsigned) {
      sql += ' UNSIGNED';
    }
    
    // Handle zerofill
    if (fieldDef.zerofill) {
      sql += ' ZEROFILL';
    }
    
    // Handle null/not null
    if (fieldDef.null === false) {
      sql += ' NOT NULL';
    } else if (fieldDef.null === true) {
      sql += ' NULL';
    }
    
    // Handle auto_increment
    if (fieldDef.auto_increment) {
      sql += ' AUTO_INCREMENT';
    }
    
    // Handle unique
    if (fieldDef.unique) {
      sql += ' UNIQUE';
    }
    
    // Handle default values
    if (fieldDef.default !== undefined) {
      if (fieldDef.default === null) {
        sql += ' DEFAULT NULL';
      } else if (typeof fieldDef.default === 'string' && 
                 (fieldDef.default.includes('CURRENT_TIMESTAMP') || 
                  fieldDef.default.includes('ON UPDATE') ||
                  fieldDef.default.toUpperCase().includes('TIMESTAMP'))) {
        sql += ` DEFAULT ${fieldDef.default}`;
      } else if (typeof fieldDef.default === 'number') {
        sql += ` DEFAULT ${fieldDef.default}`;
      } else {
        sql += ` DEFAULT '${fieldDef.default.replace(/'/g, "''")}'`;
      }
    }
    
    // Handle comments
    if (fieldDef.comment) {
      sql += ` COMMENT '${fieldDef.comment.replace(/'/g, "''")}'`;
    }
    
    return sql;
  }

  /**
   * Ensure we're using the correct database
   */
  async _ensureDatabase(pool) {
    const dbName = process.env.MYSQL_DATABASE || 'twocents_db';
    await pool.query(`USE \`${dbName}\``);
    
    // Verify database is selected
    const [rows] = await pool.query('SELECT DATABASE() as current_db');
    const currentDb = rows[0].current_db;
    
    if (currentDb !== dbName) {
      throw new Error(`Expected to use database '${dbName}' but currently using '${currentDb}'`);
    }
    
    return currentDb;
  }

  /**
   * Create table with current field and key definitions
   * @param {string} tableName - Name of the table to create
   * @param {boolean} if_not_exists - Add IF NOT EXISTS clause
   * @param {object} attributes - Table attributes (engine, charset, etc.)
   * @returns {Promise<boolean>} - Success status
   */
  async create_table(tableName, if_not_exists = true, attributes = {}) {
    if (!tableName) {
      throw new Error('A table name is required for table creation');
    }

    if (Object.keys(this.fields).length === 0) {
      throw new Error('Field information is required');
    }

    const internal = !this.pool;
    const pool = this.pool || DBForge.createPoolFromEnv();

    try {
      // Ensure we're using the correct database
      const currentDb = await this._ensureDatabase(pool);
      // Build field definitions
      const fieldDefinitions = [];
      
      for (const [fieldName, fieldDef] of Object.entries(this.fields)) {
        fieldDefinitions.push(this._build_field_sql(fieldName, fieldDef));
      }

      // Add primary key constraint
      if (this.primary_keys.length > 0) {
        const pkFields = this.primary_keys.map(field => `\`${field}\``).join(', ');
        fieldDefinitions.push(`PRIMARY KEY (${pkFields})`);
      }

      // Build CREATE TABLE statement
      const ifNotExistsClause = if_not_exists ? 'IF NOT EXISTS' : '';
      let sql = `CREATE TABLE ${ifNotExistsClause} \`${tableName}\` (\n  ${fieldDefinitions.join(',\n  ')}\n)`;

      // Add table attributes with correct MySQL syntax
      const tableAttrs = [];
      
      if (attributes.engine || this.engine) {
        tableAttrs.push(`ENGINE=${attributes.engine || this.engine}`);
      }
      
      if (attributes.charset || this.charset) {
        tableAttrs.push(`DEFAULT CHARSET=${attributes.charset || this.charset}`);
      }
      
      if (attributes.collate || this.collate) {
        tableAttrs.push(`COLLATE=${attributes.collate || this.collate}`);
      }
      
      // Add any additional custom attributes
      for (const [key, value] of Object.entries(attributes)) {
        if (!['engine', 'charset', 'collate', 'if_not_exists'].includes(key) && value !== undefined && value !== null) {
          tableAttrs.push(`${key}=${value}`);
        }
      }
      
      if (tableAttrs.length > 0) {
        sql += ` ${tableAttrs.join(' ')}`;
      }

      await pool.query(sql);
      console.log(`✓ Created table '${tableName}' in database '${currentDb}'`);

      // Create indexes separately (MySQL doesn't support all index types in CREATE TABLE)
      for (const keyField of this.keys) {
        const indexName = Array.isArray(keyField) 
          ? `idx_${tableName}_${keyField.join('_')}` 
          : `idx_${tableName}_${keyField}`;
        
        const fields = Array.isArray(keyField) ? keyField : [keyField];
        const fieldList = fields.map(f => `\`${f}\``).join(', ');
        
        const indexSql = `CREATE INDEX \`${indexName}\` ON \`${tableName}\` (${fieldList})`;
        await pool.query(indexSql);
        console.log(`✓ Created index '${indexName}' on table '${tableName}'`);
      }

      this._reset();
      return true;

    } catch (error) {
      console.error(`Error creating table ${tableName}:`, error.message);
      throw error;
    } finally {
      if (internal) await pool.end();
    }
  }

  /**
   * Drop table
   * @param {string} tableName - Name of the table to drop
   * @param {boolean} if_exists - Add IF EXISTS clause
   * @returns {Promise<boolean>} - Success status
   */
  async drop_table(tableName, if_exists = true) {
    if (!tableName) {
      throw new Error('A table name is required for table drop');
    }

    const internal = !this.pool;
    const pool = this.pool || DBForge.createPoolFromEnv();

    try {
      const ifExistsClause = if_exists ? 'IF EXISTS' : '';
      const sql = `DROP TABLE ${ifExistsClause} \`${tableName}\``;
      
      await pool.query(sql);
      return true;

    } catch (error) {
      console.error(`Error dropping table ${tableName}:`, error.message);
      throw error;
    } finally {
      if (internal) await pool.end();
    }
  }

  /**
   * Add column to existing table
   * @param {string} tableName - Name of the table
   * @param {object} field - Field definition
   * @param {string} after - Add column after this field (optional)
   * @returns {Promise<boolean>} - Success status
   */
  async add_column(tableName, field, after = null) {
    const internal = !this.pool;
    const pool = this.pool || DBForge.createPoolFromEnv();

    try {
      for (const [fieldName, fieldDef] of Object.entries(field)) {
        let sql = `ALTER TABLE \`${tableName}\` ADD COLUMN ${this._build_field_sql(fieldName, fieldDef)}`;
        
        if (after) {
          sql += ` AFTER \`${after}\``;
        }
        
        await pool.query(sql);
      }
      
      return true;

    } catch (error) {
      console.error(`Error adding column to table ${tableName}:`, error.message);
      throw error;
    } finally {
      if (internal) await pool.end();
    }
  }

  /**
   * Drop column from table
   * @param {string} tableName - Name of the table
   * @param {string} columnName - Name of the column to drop
   * @returns {Promise<boolean>} - Success status
   */
  async drop_column(tableName, columnName) {
    const internal = !this.pool;
    const pool = this.pool || DBForge.createPoolFromEnv();

    try {
      const sql = `ALTER TABLE \`${tableName}\` DROP COLUMN \`${columnName}\``;
      await pool.query(sql);
      return true;

    } catch (error) {
      console.error(`Error dropping column from table ${tableName}:`, error.message);
      throw error;
    } finally {
      if (internal) await pool.end();
    }
  }

  /**
   * Modify column in table
   * @param {string} tableName - Name of the table
   * @param {object} field - New field definition
   * @returns {Promise<boolean>} - Success status
   */
  async modify_column(tableName, field) {
    const internal = !this.pool;
    const pool = this.pool || DBForge.createPoolFromEnv();

    try {
      for (const [fieldName, fieldDef] of Object.entries(field)) {
        const sql = `ALTER TABLE \`${tableName}\` MODIFY COLUMN ${this._build_field_sql(fieldName, fieldDef)}`;
        await pool.query(sql);
      }
      
      return true;

    } catch (error) {
      console.error(`Error modifying column in table ${tableName}:`, error.message);
      throw error;
    } finally {
      if (internal) await pool.end();
    }
  }

  /**
   * Reset forge state
   */
  _reset() {
    this.fields = {};
    this.keys = [];
    this.primary_keys = [];
  }
}

// Static methods for quick table operations
class TableManager {
  /**
   * Quick table creation with field definitions
   * @param {string} tableName - Name of the table
   * @param {object} fields - Field definitions
   * @param {array} primaryKeys - Primary key field names
   * @param {array} indexes - Index field names
   * @param {object} options - Table options
   * @param {object} pool - Database pool
   * @returns {Promise<boolean>} - Success status
   */
  static async createTable(tableName, fields, primaryKeys = [], indexes = [], options = {}, pool = null) {
    const forge = new DBForge(pool);
    
    forge.add_field(fields);
    
    if (primaryKeys.length > 0) {
      forge.add_key(primaryKeys, true);
    }
    
    for (const indexField of indexes) {
      forge.add_key(indexField, false);
    }
    
    return await forge.create_table(tableName, options.if_not_exists !== false, options);
  }

  /**
   * Quick table drop
   * @param {string} tableName - Name of the table
   * @param {object} pool - Database pool
   * @param {boolean} if_exists - Add IF EXISTS clause
   * @returns {Promise<boolean>} - Success status
   */
  static async dropTable(tableName, pool = null, if_exists = true) {
    const forge = new DBForge(pool);
    return await forge.drop_table(tableName, if_exists);
  }
}

// Import query builder functionality
const { QueryBuilder, DB } = require('./query');

module.exports = {
  DBForge,
  TableManager,
  QueryBuilder,
  DB,
  createPoolFromEnv: DBForge.createPoolFromEnv
};