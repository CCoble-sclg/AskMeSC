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
    // Fetch schema directly from Azure Function (with relationships and sample values)
    if (!this.env.AZURE_FUNCTION_URL || !this.env.AZURE_FUNCTION_KEY) {
      return 'Azure Function not configured.';
    }

    try {
      const response = await fetch(
        `${this.env.AZURE_FUNCTION_URL}/api/schema?database=${database || 'Animal'}&includeValues=true`, 
        {
          headers: {
            'x-api-key': this.env.AZURE_FUNCTION_KEY,
          },
        }
      );
      
      if (!response.ok) {
        console.error('Failed to fetch schema:', response.status);
        return 'Failed to fetch database schema.';
      }
      
      interface SchemaColumn {
        name: string;
        type: string;
        nullable: boolean;
        isPrimaryKey?: boolean;
        sampleValues?: string[];
      }
      
      interface SchemaTable {
        name: string;
        schema: string;
        columns: SchemaColumn[];
        foreignKeys?: Array<{ column: string; referencesTable: string; referencesColumn: string }>;
        referencedBy?: Array<{ fromTable: string; fromColumn: string; toColumn: string }>;
      }
      
      const data = await response.json() as { 
        tables: SchemaTable[];
        relationshipCount?: number;
      };
      
      if (!data.tables || data.tables.length === 0) {
        return 'No tables found in database.';
      }
      
      // Build schema context from Azure Function response
      const parts: string[] = [];
      parts.push('DATABASE SCHEMA (auto-discovered from database):\n');
      parts.push('IMPORTANT: Use square brackets for table and column names (e.g., [dbo].[TableName], [ColumnName])\n');
      
      // Prioritize tables based on search terms if provided
      let tables = data.tables;
      if (searchTerms && searchTerms.length > 0) {
        tables = tables.sort((a, b) => {
          let aScore = 0, bScore = 0;
          for (const term of searchTerms) {
            const termLower = term.toLowerCase();
            if (a.name.toLowerCase().includes(termLower)) aScore += 5;
            if (b.name.toLowerCase().includes(termLower)) bScore += 5;
            // Also boost if columns match
            for (const col of a.columns) {
              if (col.name.toLowerCase().includes(termLower)) aScore += 1;
            }
            for (const col of b.columns) {
              if (col.name.toLowerCase().includes(termLower)) bScore += 1;
            }
          }
          return bScore - aScore;
        });
      }
      
      for (const table of tables.slice(0, 20)) {
        parts.push(`\nTable: [${table.schema}].[${table.name}]`);
        
        // Show columns with sample values
        parts.push(`  Columns:`);
        for (const col of table.columns.slice(0, 12)) {
          let colDesc = `    - [${col.name}] (${col.type})`;
          if (col.isPrimaryKey) colDesc += ' PRIMARY KEY';
          if (!col.nullable) colDesc += ' NOT NULL';
          if (col.sampleValues && col.sampleValues.length > 0) {
            colDesc += ` -- values: ${col.sampleValues.slice(0, 8).join(', ')}`;
          }
          parts.push(colDesc);
        }
        
        if (table.columns.length > 12) {
          parts.push(`    ... and ${table.columns.length - 12} more columns`);
        }
        
        // Show foreign key relationships
        if (table.foreignKeys && table.foreignKeys.length > 0) {
          parts.push(`  Relationships (JOIN via):`);
          for (const fk of table.foreignKeys.slice(0, 5)) {
            parts.push(`    - [${fk.column}] -> ${fk.referencesTable}.[${fk.referencesColumn}]`);
          }
        }
      }
      
      if (tables.length > 20) {
        parts.push(`\n... and ${tables.length - 20} more tables`);
      }
      
      if (data.relationshipCount) {
        parts.push(`\nTotal relationships discovered: ${data.relationshipCount}`);
      }
      
      return parts.join('\n');
    } catch (error) {
      console.error('Failed to fetch schema from Azure Function:', error);
      return 'Error fetching database schema.';
    }
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
