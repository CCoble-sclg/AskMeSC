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

  async searchSchemas(keywords: string[], database?: string, limit: number = 30): Promise<TableSchema[]> {
    const allSchemas = await this.getAllSchemas(database);
    
    const scored = allSchemas.map(schema => {
      let score = 0;
      const tableLower = schema.tableName.toLowerCase();
      const fullLower = schema.fullName.toLowerCase();
      
      for (const keyword of keywords) {
        const kw = keyword.toLowerCase();
        if (tableLower === kw) score += 10;
        else if (tableLower.includes(kw)) score += 5;
        else if (fullLower.includes(kw)) score += 3;
        
        for (const col of schema.columns) {
          if (col.name.toLowerCase().includes(kw)) score += 1;
        }
      }
      
      if (schema.fullName.startsWith('dbo.')) score += 2;
      
      return { schema, score };
    });
    
    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.schema);
  }

  async getSchemaContext(database?: string, searchTerms?: string[]): Promise<string> {
    // Try Azure Function first, fall back to static schema if unavailable
    if (this.env.AZURE_FUNCTION_URL && this.env.AZURE_FUNCTION_KEY) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout
        
        const response = await fetch(
          `${this.env.AZURE_FUNCTION_URL}/api/schema?database=${database || 'Animal'}`, 
          {
            headers: {
              'x-api-key': this.env.AZURE_FUNCTION_KEY,
            },
            signal: controller.signal,
          }
        );
        
        clearTimeout(timeoutId);
        
        if (response.ok) {
          return this.parseSchemaResponse(await response.json(), searchTerms);
        }
      } catch (error) {
        console.log('Azure Function unavailable, using static schema fallback');
      }
    }
    
    // Fallback: Return static schema for Animal/Kennel database
    return this.getStaticKennelSchema();
  }

  private getStaticKennelSchema(): string {
    return `DATABASE SCHEMA (Animal/Kennel Database):
IMPORTANT: Use square brackets for table and column names (e.g., [dbo].[TableName], [ColumnName])

Table: [dbo].[kennel]
  Columns:
    - [kennel_id] (int) PRIMARY KEY
    - [animal_id] (int) - links to animal table
    - [cage_number] (varchar)
    - [date_in] (datetime)
    - [date_out] (datetime) - NULL if still in kennel
    - [status] (varchar)
    - [notes] (text)

Table: [dbo].[animal]
  Columns:
    - [animal_id] (int) PRIMARY KEY
    - [animal_name] (varchar)
    - [animal_type] (varchar) - DOG, CAT, etc.
    - [breed] (varchar)
    - [color] (varchar)
    - [sex] (varchar)
    - [age] (varchar)
    - [weight] (decimal)
    - [microchip] (varchar)

Table: [dbo].[owner]
  Columns:
    - [owner_id] (int) PRIMARY KEY
    - [first_name] (varchar)
    - [last_name] (varchar)
    - [address] (varchar)
    - [city] (varchar)
    - [phone] (varchar)

Table: [dbo].[license]
  Columns:
    - [license_id] (int) PRIMARY KEY
    - [animal_id] (int)
    - [owner_id] (int)
    - [license_number] (varchar)
    - [issue_date] (datetime)
    - [expiration_date] (datetime)
    - [status] (varchar)

NOTES:
- To count animals currently in kennel: WHERE [date_out] IS NULL
- Join kennel to animal via [animal_id]
- Join license to animal and owner via respective IDs`;
  }

  private parseSchemaResponse(data: any, searchTerms?: string[]): string {
    if (!data.tables || data.tables.length === 0) {
      return this.getStaticKennelSchema();
    }
    
    const parts: string[] = [];
    parts.push('DATABASE SCHEMA (from database):\n');
    parts.push('IMPORTANT: Use square brackets for table and column names\n');
    
    let tables = data.tables;
    if (searchTerms && searchTerms.length > 0) {
      tables = [...tables].sort((a: any, b: any) => {
        let aScore = 0, bScore = 0;
        for (const term of searchTerms) {
          const termLower = term.toLowerCase();
          if (a.name.toLowerCase().includes(termLower)) aScore += 5;
          if (b.name.toLowerCase().includes(termLower)) bScore += 5;
        }
        return bScore - aScore;
      });
    }
    
    for (const table of tables.slice(0, 20)) {
      parts.push(`\nTable: [${table.schema}].[${table.name}]`);
      parts.push(`  Columns:`);
      for (const col of table.columns.slice(0, 12)) {
        let colDesc = `    - [${col.name}] (${col.type})`;
        if (col.isPrimaryKey) colDesc += ' PRIMARY KEY';
        parts.push(colDesc);
      }
      if (table.columns.length > 12) {
        parts.push(`    ... and ${table.columns.length - 12} more columns`);
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
