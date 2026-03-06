import type { Env, TableSchema, ColumnSchema } from '../types';

export class SchemaService {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  async saveSchema(schema: TableSchema): Promise<void> {
    const key = `${schema.database}.${schema.fullName}`;
    
    await this.env.DB.prepare(`
      INSERT OR REPLACE INTO table_schemas (
        schema_key, database_name, schema_name, table_name, full_name,
        columns_json, primary_key, foreign_keys_json, row_count, description, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).bind(
      key,
      schema.database,
      schema.schema,
      schema.tableName,
      schema.fullName,
      JSON.stringify(schema.columns),
      schema.primaryKey || null,
      schema.foreignKeys ? JSON.stringify(schema.foreignKeys) : null,
      schema.rowCount || 0,
      schema.description || null
    ).run();
  }

  async getSchema(database: string, tableName: string): Promise<TableSchema | null> {
    const result = await this.env.DB.prepare(`
      SELECT * FROM table_schemas 
      WHERE database_name = ? AND (full_name = ? OR table_name = ?)
    `).bind(database, tableName, tableName).first();

    if (!result) return null;

    return {
      database: result.database_name as string,
      schema: result.schema_name as string,
      tableName: result.table_name as string,
      fullName: result.full_name as string,
      columns: JSON.parse(result.columns_json as string),
      primaryKey: result.primary_key as string | undefined,
      foreignKeys: result.foreign_keys_json 
        ? JSON.parse(result.foreign_keys_json as string) 
        : undefined,
      rowCount: result.row_count as number,
      description: result.description as string | undefined,
    };
  }

  async getAllSchemas(database?: string): Promise<TableSchema[]> {
    let query = 'SELECT * FROM table_schemas';
    const params: string[] = [];
    
    if (database) {
      query += ' WHERE database_name = ?';
      params.push(database);
    }
    
    query += ' ORDER BY database_name, full_name';

    const result = database 
      ? await this.env.DB.prepare(query).bind(database).all()
      : await this.env.DB.prepare(query).all();

    return result.results.map((row: any) => ({
      database: row.database_name,
      schema: row.schema_name,
      tableName: row.table_name,
      fullName: row.full_name,
      columns: JSON.parse(row.columns_json),
      primaryKey: row.primary_key,
      foreignKeys: row.foreign_keys_json 
        ? JSON.parse(row.foreign_keys_json) 
        : undefined,
      rowCount: row.row_count,
      description: row.description,
    }));
  }

  async getSchemaContext(database?: string): Promise<string> {
    const schemas = await this.getAllSchemas(database);
    
    if (schemas.length === 0) {
      return 'No tables available.';
    }

    const parts: string[] = [];
    parts.push('Available database tables:\n');
    parts.push('IMPORTANT: Table names use underscores, not dots (e.g., dbo_TableName not dbo.TableName)\n');

    for (const schema of schemas) {
      const postgresTableName = schema.fullName.replace('.', '_');
      parts.push(`\nTable: "${postgresTableName}"`);
      if (schema.description) {
        parts.push(`  Description: ${schema.description}`);
      }
      parts.push(`  Columns:`);
      
      for (const col of schema.columns) {
        let colDesc = `    - ${col.name} (${col.postgresType})`;
        if (col.isPrimaryKey) colDesc += ' PRIMARY KEY';
        if (col.isForeignKey && col.referencedTable) {
          colDesc += ` -> ${col.referencedTable}`;
        }
        parts.push(colDesc);
      }

      if (schema.foreignKeys && schema.foreignKeys.length > 0) {
        parts.push(`  Relationships:`);
        for (const fk of schema.foreignKeys) {
          parts.push(`    - ${fk.column} references ${fk.referencedTable}.${fk.referencedColumn}`);
        }
      }
    }

    return parts.join('\n');
  }

  async deleteSchema(database: string, tableName: string): Promise<void> {
    await this.env.DB.prepare(`
      DELETE FROM table_schemas 
      WHERE database_name = ? AND (full_name = ? OR table_name = ?)
    `).bind(database, tableName, tableName).run();
  }

  async deleteAllSchemas(database: string): Promise<void> {
    await this.env.DB.prepare(`
      DELETE FROM table_schemas WHERE database_name = ?
    `).bind(database).run();
  }
}

export function mapSqlServerToPostgres(sqlServerType: string): string {
  const typeMap: Record<string, string> = {
    'int': 'INTEGER',
    'bigint': 'BIGINT',
    'smallint': 'SMALLINT',
    'tinyint': 'SMALLINT',
    'bit': 'BOOLEAN',
    'decimal': 'DECIMAL',
    'numeric': 'NUMERIC',
    'money': 'DECIMAL(19,4)',
    'smallmoney': 'DECIMAL(10,4)',
    'float': 'DOUBLE PRECISION',
    'real': 'REAL',
    'datetime': 'TIMESTAMP',
    'datetime2': 'TIMESTAMP',
    'smalldatetime': 'TIMESTAMP',
    'date': 'DATE',
    'time': 'TIME',
    'datetimeoffset': 'TIMESTAMPTZ',
    'char': 'CHAR',
    'varchar': 'VARCHAR',
    'text': 'TEXT',
    'nchar': 'CHAR',
    'nvarchar': 'VARCHAR',
    'ntext': 'TEXT',
    'binary': 'BYTEA',
    'varbinary': 'BYTEA',
    'image': 'BYTEA',
    'uniqueidentifier': 'UUID',
    'xml': 'XML',
  };

  const basetype = sqlServerType.toLowerCase().split('(')[0].trim();
  return typeMap[basetype] || 'TEXT';
}
