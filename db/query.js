const mysql = require('mysql2/promise');

/**
 * Database Query Builder - Provides CRUD operations for database tables
 * Similar to CodeIgniter's Active Record / Query Builder
 */
class QueryBuilder {
  constructor(pool = null) {
    this.pool = pool;
    this.table_name = null;
    this.where_conditions = [];
    this.join_conditions = [];
    this.select_fields = ['*'];
    this.order_by_fields = [];
    this.group_by_fields = [];
    this.having_conditions = [];
    this.limit_count = null;
    this.offset_count = null;
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
   * Set table name for operations
   * @param {string} tableName - Name of the table
   * @returns {QueryBuilder} - Returns this for chaining
   */
  table(tableName) {
    this.table_name = tableName;
    return this;
  }

  /**
   * Set fields to select
   * @param {string|array} fields - Fields to select
   * @returns {QueryBuilder} - Returns this for chaining
   */
  select(fields = '*') {
    if (typeof fields === 'string') {
      this.select_fields = fields === '*' ? ['*'] : [fields];
    } else {
      this.select_fields = fields;
    }
    return this;
  }

  /**
   * Add WHERE condition
   * @param {string|object} field - Field name or conditions object
   * @param {string|any} value - Value to compare (optional if field is object)
   * @param {string} operator - Comparison operator (default: '=')
   * @returns {QueryBuilder} - Returns this for chaining
   */
  where(field, value = null, operator = '=') {
    if (typeof field === 'object') {
      // Handle object of conditions
      for (const [key, val] of Object.entries(field)) {
        this.where_conditions.push({ field: key, operator: '=', value: val, type: 'AND' });
      }
    } else {
      this.where_conditions.push({ field, operator, value, type: 'AND' });
    }
    return this;
  }

  /**
   * Add WHERE condition with OR
   * @param {string|object} field - Field name or conditions object
   * @param {string|any} value - Value to compare (optional if field is object)
   * @param {string} operator - Comparison operator (default: '=')
   * @returns {QueryBuilder} - Returns this for chaining
   */
  or_where(field, value = null, operator = '=') {
    if (typeof field === 'object') {
      for (const [key, val] of Object.entries(field)) {
        this.where_conditions.push({ field: key, operator: '=', value: val, type: 'OR' });
      }
    } else {
      this.where_conditions.push({ field, operator, value, type: 'OR' });
    }
    return this;
  }

  /**
   * Add WHERE IN condition
   * @param {string} field - Field name
   * @param {array} values - Array of values
   * @returns {QueryBuilder} - Returns this for chaining
   */
  where_in(field, values) {
    this.where_conditions.push({ field, operator: 'IN', value: values, type: 'AND' });
    return this;
  }

  /**
   * Add WHERE NOT IN condition
   * @param {string} field - Field name
   * @param {array} values - Array of values
   * @returns {QueryBuilder} - Returns this for chaining
   */
  where_not_in(field, values) {
    this.where_conditions.push({ field, operator: 'NOT IN', value: values, type: 'AND' });
    return this;
  }

  /**
   * Add WHERE LIKE condition
   * @param {string} field - Field name
   * @param {string} value - Value to match
   * @returns {QueryBuilder} - Returns this for chaining
   */
  like(field, value) {
    this.where_conditions.push({ field, operator: 'LIKE', value, type: 'AND' });
    return this;
  }

  /**
   * Add ORDER BY clause
   * @param {string} field - Field name
   * @param {string} direction - ASC or DESC
   * @returns {QueryBuilder} - Returns this for chaining
   */
  order_by(field, direction = 'ASC') {
    this.order_by_fields.push({ field, direction: direction.toUpperCase() });
    return this;
  }

  /**
   * Add GROUP BY clause
   * @param {string} field - Field name
   * @returns {QueryBuilder} - Returns this for chaining
   */
  group_by(field) {
    this.group_by_fields.push(field);
    return this;
  }

  /**
   * Add HAVING clause
   * @param {string} field - Field name
   * @param {any} value - Value to compare
   * @param {string} operator - Comparison operator
   * @returns {QueryBuilder} - Returns this for chaining
   */
  having(field, value, operator = '=') {
    this.having_conditions.push({ field, operator, value });
    return this;
  }

  /**
   * Set LIMIT
   * @param {number} limit - Number of records to limit
   * @param {number} offset - Offset for pagination
   * @returns {QueryBuilder} - Returns this for chaining
   */
  limit(limit, offset = null) {
    this.limit_count = limit;
    if (offset !== null) {
      this.offset_count = offset;
    }
    return this;
  }

  /**
   * Build WHERE clause
   * @returns {object} - Object with sql and values
   */
  _build_where() {
    if (this.where_conditions.length === 0) {
      return { sql: '', values: [] };
    }

    let whereSql = ' WHERE ';
    const values = [];
    
    this.where_conditions.forEach((condition, index) => {
      if (index > 0) {
        whereSql += ` ${condition.type} `;
      }
      
      if (condition.operator === 'IN' || condition.operator === 'NOT IN') {
        const placeholders = condition.value.map(() => '?').join(', ');
        whereSql += `\`${condition.field}\` ${condition.operator} (${placeholders})`;
        values.push(...condition.value);
      } else {
        whereSql += `\`${condition.field}\` ${condition.operator} ?`;
        values.push(condition.value);
      }
    });

    return { sql: whereSql, values };
  }

  /**
   * Build ORDER BY clause
   * @returns {string} - ORDER BY SQL
   */
  _build_order_by() {
    if (this.order_by_fields.length === 0) {
      return '';
    }
    
    const orderFields = this.order_by_fields.map(field => `\`${field.field}\` ${field.direction}`);
    return ` ORDER BY ${orderFields.join(', ')}`;
  }

  /**
   * Build GROUP BY clause
   * @returns {string} - GROUP BY SQL
   */
  _build_group_by() {
    if (this.group_by_fields.length === 0) {
      return '';
    }
    
    const groupFields = this.group_by_fields.map(field => `\`${field}\``);
    return ` GROUP BY ${groupFields.join(', ')}`;
  }

  /**
   * Build HAVING clause
   * @returns {object} - Object with sql and values
   */
  _build_having() {
    if (this.having_conditions.length === 0) {
      return { sql: '', values: [] };
    }

    let havingSql = ' HAVING ';
    const values = [];
    
    this.having_conditions.forEach((condition, index) => {
      if (index > 0) {
        havingSql += ' AND ';
      }
      havingSql += `\`${condition.field}\` ${condition.operator} ?`;
      values.push(condition.value);
    });

    return { sql: havingSql, values };
  }

  /**
   * Build LIMIT clause
   * @returns {string} - LIMIT SQL
   */
  _build_limit() {
    if (this.limit_count === null) {
      return '';
    }
    
    let limitSql = ` LIMIT ${this.limit_count}`;
    if (this.offset_count !== null) {
      limitSql += ` OFFSET ${this.offset_count}`;
    }
    
    return limitSql;
  }

  /**
   * Get records from table
   * @returns {Promise<array>} - Array of records
   */
  async get() {
    if (!this.table_name) {
      throw new Error('Table name is required');
    }

    const internal = !this.pool;
    const pool = this.pool || QueryBuilder.createPoolFromEnv();

    try {
      // Build SELECT fields
      const selectFields = this.select_fields.join(', ');
      
      // Build WHERE clause
      const whereClause = this._build_where();
      
      // Build GROUP BY clause
      const groupByClause = this._build_group_by();
      
      // Build HAVING clause
      const havingClause = this._build_having();
      
      // Build ORDER BY clause
      const orderByClause = this._build_order_by();
      
      // Build LIMIT clause
      const limitClause = this._build_limit();

      const sql = `SELECT ${selectFields} FROM \`${this.table_name}\`${whereClause.sql}${groupByClause}${havingClause.sql}${orderByClause}${limitClause}`;
      const values = [...whereClause.values, ...havingClause.values];

      const [rows] = await pool.query(sql, values);
      return rows;

    } catch (error) {
      console.error('Error in get():', error.message);
      throw error;
    } finally {
      if (internal) await pool.end();
      this._reset();
    }
  }

  /**
   * Get single record from table
   * @returns {Promise<object|null>} - Single record or null
   */
  async get_one() {
    this.limit(1);
    const results = await this.get();
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Insert record into table
   * @param {object} data - Data to insert
   * @returns {Promise<object>} - Insert result with insertId
   */
  async insert(data) {
    if (!this.table_name) {
      throw new Error('Table name is required');
    }

    const internal = !this.pool;
    const pool = this.pool || QueryBuilder.createPoolFromEnv();

    try {
      const fields = Object.keys(data);
      const values = Object.values(data);
      const placeholders = fields.map(() => '?').join(', ');
      const fieldNames = fields.map(field => `\`${field}\``).join(', ');

      const sql = `INSERT INTO \`${this.table_name}\` (${fieldNames}) VALUES (${placeholders})`;
      
      const [result] = await pool.query(sql, values);
      
      return {
        success: true,
        insertId: result.insertId,
        affectedRows: result.affectedRows
      };

    } catch (error) {
      console.error('Error in insert():', error.message);
      throw error;
    } finally {
      if (internal) await pool.end();
      this._reset();
    }
  }

  /**
   * Insert multiple records into table
   * @param {array} dataArray - Array of data objects to insert
   * @returns {Promise<object>} - Insert result
   */
  async insert_batch(dataArray) {
    if (!this.table_name) {
      throw new Error('Table name is required');
    }
    
    if (!Array.isArray(dataArray) || dataArray.length === 0) {
      throw new Error('Data array is required and cannot be empty');
    }

    const internal = !this.pool;
    const pool = this.pool || QueryBuilder.createPoolFromEnv();

    try {
      const fields = Object.keys(dataArray[0]);
      const fieldNames = fields.map(field => `\`${field}\``).join(', ');
      
      const values = [];
      const placeholderGroups = [];
      
      dataArray.forEach(data => {
        const rowValues = fields.map(field => data[field]);
        values.push(...rowValues);
        placeholderGroups.push(`(${fields.map(() => '?').join(', ')})`);
      });

      const sql = `INSERT INTO \`${this.table_name}\` (${fieldNames}) VALUES ${placeholderGroups.join(', ')}`;
      
      const [result] = await pool.query(sql, values);
      
      return {
        success: true,
        insertId: result.insertId,
        affectedRows: result.affectedRows
      };

    } catch (error) {
      console.error('Error in insert_batch():', error.message);
      throw error;
    } finally {
      if (internal) await pool.end();
      this._reset();
    }
  }

  /**
   * Update records in table
   * @param {object} data - Data to update
   * @returns {Promise<object>} - Update result
   */
  async update(data) {
    if (!this.table_name) {
      throw new Error('Table name is required');
    }
    
    if (this.where_conditions.length === 0) {
      throw new Error('WHERE conditions are required for update operations');
    }

    const internal = !this.pool;
    const pool = this.pool || QueryBuilder.createPoolFromEnv();

    try {
      const fields = Object.keys(data);
      const updateValues = Object.values(data);
      const setClause = fields.map(field => `\`${field}\` = ?`).join(', ');
      
      const whereClause = this._build_where();
      
      const sql = `UPDATE \`${this.table_name}\` SET ${setClause}${whereClause.sql}`;
      const values = [...updateValues, ...whereClause.values];

      const [result] = await pool.query(sql, values);
      
      return {
        success: true,
        affectedRows: result.affectedRows,
        changedRows: result.changedRows
      };

    } catch (error) {
      console.error('Error in update():', error.message);
      throw error;
    } finally {
      if (internal) await pool.end();
      this._reset();
    }
  }

  /**
   * Delete records from table
   * @returns {Promise<object>} - Delete result
   */
  async delete() {
    if (!this.table_name) {
      throw new Error('Table name is required');
    }
    
    if (this.where_conditions.length === 0) {
      throw new Error('WHERE conditions are required for delete operations');
    }

    const internal = !this.pool;
    const pool = this.pool || QueryBuilder.createPoolFromEnv();

    try {
      const whereClause = this._build_where();
      
      const sql = `DELETE FROM \`${this.table_name}\`${whereClause.sql}`;

      const [result] = await pool.query(sql, whereClause.values);
      
      return {
        success: true,
        affectedRows: result.affectedRows
      };

    } catch (error) {
      console.error('Error in delete():', error.message);
      throw error;
    } finally {
      if (internal) await pool.end();
      this._reset();
    }
  }

  /**
   * Count records in table
   * @param {string} field - Field to count (default: '*')
   * @returns {Promise<number>} - Count result
   */
  async count(field = '*') {
    if (!this.table_name) {
      throw new Error('Table name is required');
    }

    const internal = !this.pool;
    const pool = this.pool || QueryBuilder.createPoolFromEnv();

    try {
      const whereClause = this._build_where();
      
      const sql = `SELECT COUNT(${field}) as count FROM \`${this.table_name}\`${whereClause.sql}`;

      const [rows] = await pool.query(sql, whereClause.values);
      
      return rows[0].count;

    } catch (error) {
      console.error('Error in count():', error.message);
      throw error;
    } finally {
      if (internal) await pool.end();
      this._reset();
    }
  }

  /**
   * Execute raw SQL query
   * @param {string} sql - SQL query
   * @param {array} values - Query parameters
   * @returns {Promise<array>} - Query result
   */
  async query(sql, values = []) {
    const internal = !this.pool;
    const pool = this.pool || QueryBuilder.createPoolFromEnv();

    try {
      const [rows] = await pool.query(sql, values);
      return rows;

    } catch (error) {
      console.error('Error in query():', error.message);
      throw error;
    } finally {
      if (internal) await pool.end();
    }
  }

  /**
   * Reset query builder state
   */
  _reset() {
    this.table_name = null;
    this.where_conditions = [];
    this.join_conditions = [];
    this.select_fields = ['*'];
    this.order_by_fields = [];
    this.group_by_fields = [];
    this.having_conditions = [];
    this.limit_count = null;
    this.offset_count = null;
  }
}

// Helper functions for quick operations
class DB {
  static pool = null;

  /**
   * Initialize database pool
   * @param {object} pool - Database pool (optional)
   */
  static init(pool = null) {
    DB.pool = pool || QueryBuilder.createPoolFromEnv();
  }

  /**
   * Get a new query builder instance
   * @param {string} tableName - Table name (optional)
   * @returns {QueryBuilder} - Query builder instance
   */
  static table(tableName = null) {
    const qb = new QueryBuilder(DB.pool);
    return tableName ? qb.table(tableName) : qb;
  }

  /**
   * Quick insert operation
   * @param {string} tableName - Table name
   * @param {object} data - Data to insert
   * @returns {Promise<object>} - Insert result
   */
  static async insert(tableName, data) {
    return await DB.table(tableName).insert(data);
  }

  /**
   * Quick find operation
   * @param {string} tableName - Table name
   * @param {object} conditions - Where conditions
   * @returns {Promise<array>} - Query result
   */
  static async find(tableName, conditions = {}) {
    return await DB.table(tableName).where(conditions).get();
  }

  /**
   * Quick find one operation
   * @param {string} tableName - Table name
   * @param {object} conditions - Where conditions
   * @returns {Promise<object|null>} - Single record or null
   */
  static async find_one(tableName, conditions = {}) {
    return await DB.table(tableName).where(conditions).get_one();
  }

  /**
   * Quick update operation
   * @param {string} tableName - Table name
   * @param {object} data - Data to update
   * @param {object} conditions - Where conditions
   * @returns {Promise<object>} - Update result
   */
  static async update(tableName, data, conditions) {
    return await DB.table(tableName).where(conditions).update(data);
  }

  /**
   * Quick delete operation
   * @param {string} tableName - Table name
   * @param {object} conditions - Where conditions
   * @returns {Promise<object>} - Delete result
   */
  static async delete(tableName, conditions) {
    return await DB.table(tableName).where(conditions).delete();
  }

  /**
   * Execute raw SQL query
   * @param {string} sql - SQL query
   * @param {array} values - Query parameters
   * @returns {Promise<array>} - Query result
   */
  static async query(sql, values = []) {
    return await DB.table().query(sql, values);
  }
}

module.exports = {
  QueryBuilder,
  DB
};