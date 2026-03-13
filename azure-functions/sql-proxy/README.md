# AskMeSC SQL Proxy Azure Function

This Azure Function acts as a secure proxy between the Cloudflare Worker and Azure SQL databases.

## Setup Instructions

### 1. Install Dependencies

```bash
cd azure-functions/sql-proxy
npm install
```

### 2. Configure Local Settings

Edit `local.settings.json` with your values:

```json
{
  "Values": {
    "API_KEY": "generate-a-secure-random-key",
    "DB_ANIMAL_SERVER": "sclg-askmesc.database.windows.net",
    "DB_ANIMAL_DATABASE": "Animal",
    "DB_ANIMAL_USER": "sclg-store-sql-admin",
    "DB_ANIMAL_PASSWORD": "your-actual-password"
  }
}
```

### 3. Test Locally

```bash
npm start
```

Test the health endpoint:
```bash
curl http://localhost:7071/api/health
```

### 4. Deploy to Azure

```bash
# Login to Azure
az login

# Create a Function App (if not exists)
az functionapp create \
  --resource-group AskMeSC \
  --consumption-plan-location westus2 \
  --runtime node \
  --runtime-version 20 \
  --functions-version 4 \
  --name askmesc-sql-proxy \
  --storage-account <storage-account-name>

# Deploy
func azure functionapp publish askmesc-sql-proxy
```

### 5. Configure App Settings in Azure

In Azure Portal, go to your Function App → Configuration → Application settings:

- `API_KEY`: Your secure API key (same as you'll use in Cloudflare)
- `DB_ANIMAL_SERVER`: sclg-askmesc.database.windows.net
- `DB_ANIMAL_DATABASE`: Animal  
- `DB_ANIMAL_USER`: sclg-store-sql-admin
- `DB_ANIMAL_PASSWORD`: Your password

### 6. Configure Cloudflare Worker

Add these secrets to your Cloudflare Worker:

```bash
cd apps/api

# Set the Azure Function URL
npx wrangler secret put AZURE_FUNCTION_URL
# Enter: https://askmesc-sql-proxy.azurewebsites.net

# Set the API key (must match the one in Azure)
npx wrangler secret put AZURE_FUNCTION_KEY
# Enter: your-secure-api-key
```

## Adding More Databases

To add a new database, add these environment variables in Azure:

```
DB_NEWDBNAME_SERVER=server.database.windows.net
DB_NEWDBNAME_DATABASE=DatabaseName
DB_NEWDBNAME_USER=username
DB_NEWDBNAME_PASSWORD=password
```

Then query it by passing `database: "NEWDBNAME"` in your requests.

## API Endpoints

### POST /api/query
Execute a SQL query.

**Headers:**
- `x-api-key`: Your API key

**Body:**
```json
{
  "database": "Animal",
  "query": "SELECT TOP 10 * FROM [dbo].[TableName]"
}
```

**Response:**
```json
{
  "rows": [...],
  "rowCount": 10,
  "executionTimeMs": 45
}
```

### GET /api/schema?database=Animal
Get database schema information.

### GET /api/health
Health check endpoint.
