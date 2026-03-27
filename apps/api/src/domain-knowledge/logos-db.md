# Logos Database - Complete Domain Knowledge

## Overview
The Logos database is a **Tyler Munis** government ERP system covering financial management, human resources, utility billing, and more. It's hosted on SQL Server.

**Database Stats:**
- ~2,666 tables across multiple schemas
- Financial data from fiscal years 2000-2026
- Primary use: Finance, HR, Utility Billing, Purchasing, Fixed Assets

---

## Schema Organization

| Schema | Table Count | Purpose |
|--------|-------------|---------|
| dbo | 1,590 | Core financial, AP, AR, purchasing, assets, projects |
| HR | 509 | Human resources, payroll, benefits, employees |
| UT | 172 | Utility management extensions |
| FM | 119 | Financial management extensions |
| Suite | 57 | System configuration, security |
| FM.WO | 40 | Work orders |
| ePay | 9 | Electronic payments |
| TOR | 5 | Time-off requests |

**SCHEMAS NOT USED:**
- CD (Community Development) - NOT USED
- MCD (Inspections) - NOT USED

---

## CRITICAL: Budget vs Expense Queries

The most common query pattern is distinguishing **budget** from **expenses** in `JournalDetail`.

### Transaction Sources (JournalDetail.Source)

**BUDGET SOURCES (Exclude from expense calculations):**
- `BudgetProcessing` - Original budget
- `BA YYYY-##` - Budget amendments
- `Budget` - Budget entries

**EXPENSE/ACTUAL SOURCES (Include in calculations):**
- `Accounts Payable` - AP transactions
- `AcctsPaybl` - AP (alternate name)
- `Purchase Orders` - PO activity
- `JE-###`, `JE ###` - Journal entries
- `JV-###` - Journal vouchers
- `Payroll Post` - Payroll
- `Human Rsrc` - HR transactions
- `Asset Management` - Fixed assets
- `UtilBill`, `Utility Mgmt` - Utility
- `Collections`, `Revenue Collecti` - Revenue

**OTHER SOURCES:**
- `Year End` - Year-end closing
- `Soft Close` - Soft close adjustments
- `Migration` - Data migration

### Budget vs Actual Query Pattern

```sql
SELECT 
    ga.GLAccountDelimitedFull,
    SUM(CASE WHEN jd.Source = 'BudgetProcessing' THEN jd.Amount ELSE 0 END) as OriginalBudget,
    SUM(CASE WHEN jd.Source LIKE 'BA %' THEN jd.Amount ELSE 0 END) as Amendments,
    SUM(CASE WHEN jd.Source NOT IN ('BudgetProcessing') 
             AND jd.Source NOT LIKE 'BA %' 
             AND jd.Source NOT LIKE 'Budget%'
        THEN jd.Amount ELSE 0 END) as Expenses,
    SUM(CASE WHEN jd.Source = 'BudgetProcessing' OR jd.Source LIKE 'BA %' 
        THEN jd.Amount ELSE 0 END) -
    SUM(CASE WHEN jd.Source NOT IN ('BudgetProcessing') 
             AND jd.Source NOT LIKE 'BA %'
             AND jd.Source NOT LIKE 'Budget%'
        THEN jd.Amount ELSE 0 END) as RemainingBalance
FROM dbo.JournalDetail jd
JOIN dbo.GLAccount ga ON jd.GLAccountID = ga.GLAccountID
WHERE jd.FiscalEndYear = 2026
GROUP BY ga.GLAccountDelimitedFull
```

---

## General Ledger Core Tables

### Fiscal Year Concept
- Tracked by `FiscalEndYear` column (e.g., 2026)
- **ALWAYS filter by FiscalEndYear for current balances**
- Government FY typically ends June 30

### GL Account Structure
Format: `Fund.Department Object.SubObject`
Example: `110.3500 330.50`
- **Fund** (110) - Fund code
- **Department** (3500) - Cost center/department
- **Object** (330.50) - Expense/revenue type

### dbo.GLAccount
Master list of all GL accounts.

| Column | Type | Description |
|--------|------|-------------|
| GLAccountID | int | Primary key |
| GLAccountDelimitedFull | varchar | Human-readable code (e.g., "110.3500 330.50") |
| GLAccountCodeScrunched | varchar | No delimiters (e.g., "110350033050") |
| Org1Code | varchar | Fund code |
| Org2Code-Org6Code | varchar | Department hierarchy codes |
| AccountID | int | FK to Account |
| BudgetType | | Budget category |
| TransactionFlag | bit | Can have transactions |
| BudgetFlag | bit | Can have budget |

### dbo.JournalDetail
**THE MAIN TRANSACTION TABLE** - Contains ALL financial transactions.

| Column | Type | Description |
|--------|------|-------------|
| JournalDetailID | int | Primary key |
| JournalID | int | Links to JournalHeader |
| GLAccountID | int | FK to GLAccount |
| GLDate | datetime | Transaction date |
| FiscalEndYear | smallint | **CRITICAL: Fiscal year** |
| Amount | money | Transaction amount |
| Source | varchar | **CRITICAL: Transaction type** |
| Description | varchar | Description |
| ProjectID | int | Optional project link |

### dbo.Account
Account code definitions.

| Column | Type | Description |
|--------|------|-------------|
| AccountID | int | Primary key |
| AccountType | tinyint | 1=Asset, 2=Liability, 3=Fund Balance, 4=Revenue, 5=Expenditure |
| AccountCode | varchar | Account code (e.g., "5101") |
| AccountDescription | varchar | Account name |

### dbo.Organization1
Fund definitions.

| Column | Type | Description |
|--------|------|-------------|
| OrganizationID | int | Primary key |
| OrganizationCode | varchar | Fund code (e.g., "110", "210") |
| Description | varchar | Fund name |
| CurrentFiscalEndYear | smallint | Current fiscal year |

---

## Accounts Payable Tables

### dbo.Vendor
Vendor master file.

| Column | Type | Description |
|--------|------|-------------|
| VendorID | int | Primary key |
| CentralNameID | int | FK to CentralName |
| VendorNumber | int | Vendor number |
| SubjectTo1099Flag | bit | 1099 reporting |
| ActiveFlag | bit | Active status |
| ExpenseAccountID | int | Default expense account |

### dbo.AccountsPayableInvoice
AP invoices.

| Column | Type | Description |
|--------|------|-------------|
| InvoiceID | int | Primary key |
| VendorID | int | FK to Vendor |
| InvoiceNumber | varchar | Invoice number |
| InvoiceAmount | money | Total amount |
| InvoiceDate | datetime | Invoice date |
| InvoiceGLDate | datetime | GL posting date |
| InvoiceProcessStatus | tinyint | Status |
| VoidedInvoiceStatus | tinyint | Void status |

### dbo.AccountsPayableInvoiceItem
Invoice line items with GL distribution.

---

## Purchasing Tables

### dbo.PurchaseOrder
Purchase orders.

| Column | Type | Description |
|--------|------|-------------|
| PurchaseOrderID | int | Primary key |
| PONumber | varchar | PO number |
| VendorID | int | FK to Vendor |
| ProcessStatus | tinyint | Status |
| GLDate | datetime | GL date |
| FiscalYear | smallint | Fiscal year |
| EncumberFundsFlag | bit | Encumbrance |

### dbo.PurchaseOrderDetail
PO line items.

### dbo.PurchaseRequest
Purchase requisitions.

---

## Human Resources Tables (HR Schema)

### HR.Employee
Employee master - links all employee data.

| Column | Type | Description |
|--------|------|-------------|
| EmployeeId | int | Primary key |
| EmployeeNumber | int | Employee number |
| EmployeeNumberString | varchar | String version |
| RecordStatus | | Active/inactive |
| ApplicantId | int | If hired from applicant |

### HR.EmployeeName
Employee names (supports history).

| Column | Type | Description |
|--------|------|-------------|
| EmployeeNameId | int | Primary key |
| EmployeeId | int | FK to Employee |
| EffectiveDate | datetime | Start date |
| EffectiveEndDate | datetime | End date (NULL = current) |
| FirstName | varchar | First name |
| LastName | varchar | Last name |
| MiddleName | varchar | Middle name |

### HR.EmployeeJob
Job/position assignments.

| Column | Type | Description |
|--------|------|-------------|
| EmployeeJobId | int | Primary key |
| EmployeeId | int | FK to Employee |
| EffectiveDate | datetime | Start date |
| EffectiveEndDate | datetime | End date (NULL = current) |
| IsPrimaryJob | bit | Primary position |
| PositionId | int | Position |
| Title | varchar | Job title |
| DepartmentId | int | Department |
| RateAmount | money | Pay rate |
| AnnualHours | decimal | Annual hours |
| FTE | decimal | Full-time equivalent |

### HR.EmployeeEmployment
Employment status tracking.

| Column | Type | Description |
|--------|------|-------------|
| EmployeeEmploymentId | int | Primary key |
| EmployeeId | int | FK to Employee |
| EffectiveDate | datetime | Start date |
| EffectiveEndDate | datetime | End date (9999-12-31 = current) |
| vsEmploymentStatusId | int | Status code |
| TerminationDate | datetime | Termination date |

**vsEmploymentStatusId Values:**
- 518 = ACTIVE
- 519 = TERMINATED
- 517 = Leave/Inactive
- 520 = Retired

### dbo.PayrollEarnings
Payroll earnings records.

| Column | Type | Description |
|--------|------|-------------|
| PayrollEarningsID | int | Primary key |
| EmployeeID | int | FK to Employee |
| PayBatchID | int | Pay batch |
| GrossAmount | money | Gross pay |
| NetAmount | money | Net pay |
| VoidedFlag | bit | Voided |
| OrgStructureID | int | Department |

### Employee Query Patterns

```sql
-- Active employee count
SELECT COUNT(DISTINCT EmployeeId)
FROM HR.EmployeeEmployment
WHERE vsEmploymentStatusId = 518
  AND EffectiveEndDate = '9999-12-31'
  AND TerminationDate IS NULL

-- Current employee list with job info and department
SELECT 
    e.EmployeeNumber,
    en.FirstName,
    en.LastName,
    ej.Title,
    ej.DepartmentId,
    os.Description as Department
FROM HR.Employee e
JOIN HR.EmployeeName en ON e.EmployeeId = en.EmployeeId
JOIN HR.EmployeeJob ej ON e.EmployeeId = ej.EmployeeId
LEFT JOIN dbo.OrgStructure os ON ej.DepartmentId = os.OrgStructureID
WHERE en.EffectiveEndDate IS NULL
  AND ej.EffectiveEndDate IS NULL
  AND ej.IsPrimaryJob = 1
  AND e.RecordStatus = 1

-- Employees hired since a specific date (new hires)
-- Note: EffectiveDate in EmployeeEmployment is the hire/status change date
SELECT 
    e.EmployeeNumber,
    en.FirstName,
    en.LastName,
    ee.EffectiveDate as HireDate,
    ej.Title,
    os.Description as Department
FROM HR.EmployeeEmployment ee
JOIN HR.Employee e ON ee.EmployeeId = e.EmployeeId
JOIN HR.EmployeeName en ON e.EmployeeId = en.EmployeeId
JOIN HR.EmployeeJob ej ON e.EmployeeId = ej.EmployeeId
LEFT JOIN dbo.OrgStructure os ON ej.DepartmentId = os.OrgStructureID
WHERE ee.vsEmploymentStatusId = 518
  AND ee.EffectiveDate >= '2026-01-01'  -- Change this date
  AND ee.EffectiveEndDate = '9999-12-31'
  AND en.EffectiveEndDate IS NULL
  AND ej.EffectiveEndDate IS NULL
  AND ej.IsPrimaryJob = 1
```

---

## Utility Billing Tables

### dbo.UtilityAccount
Service locations/accounts.

| Column | Type | Description |
|--------|------|-------------|
| UtilityAccountID | int | Primary key |
| AccountNumber | varchar | Account number |
| FullAccountNumber | varchar | Full account (includes sequence) |
| AccountStatus | int | 1=Active, 2=Inactive |
| AccountOpenDate | datetime | Open date |
| AccountCloseDate | datetime | Close date (if closed) |

### dbo.UtilityCustomerAccount
Links customers to service accounts.

| Column | Type | Description |
|--------|------|-------------|
| UtilityCustomerAccountId | int | Primary key |
| UtilityCustomerID | int | Customer |
| UtilityAccountID | int | Service account |
| CustomerAccountBeginDate | datetime | Start date |
| CustomerAccountEndDate | datetime | End date |
| PrimaryBillFlag | bit | Primary for billing |
| OwnerFlag | bit | Owner vs tenant |

### dbo.UtilityBill
Bills generated for accounts.

### dbo.UtilityTransactionHeader / UtilityTransactionDetail
Utility billing transactions.

---

## Fixed Assets Tables

### dbo.Asset
Fixed asset records.

| Column | Type | Description |
|--------|------|-------------|
| AssetID | int | Primary key |
| AssetNumber | varchar | Asset # |
| AssetDescription | varchar | Description |
| CapitalizationDate | datetime | Cap date |
| OriginalPurchasePrice | money | Cost |
| AssetLifeInMonths | int | Useful life |
| DepreciationMethodID | int | Depreciation method |
| ActiveFlag | bit | Active |
| BarcodeNumber | varchar | Barcode |
| ManufacturerSerialNumber | varchar | Serial # |

### dbo.AssetTran
Asset transactions (depreciation, transfers, etc.)

---

## Grants Tables

### dbo.Grants
Grant records.

| Column | Type | Description |
|--------|------|-------------|
| GrantID | int | Primary key |
| GrantNumber | varchar | Grant # |
| Title | varchar | Title |
| Description | varchar | Description |
| StartDate | datetime | Start |
| EndDate | datetime | End |
| PrimaryGrantorID | int | Grantor |
| ActiveFlag | bit | Active |

---

## Projects Tables

### dbo.Project
Project tracking.

| Column | Type | Description |
|--------|------|-------------|
| ProjectID | int | Primary key |
| ProjectLevelID1 | int | Level 1 code |
| ProjectLevelID2 | int | Level 2 code |
| ProjectLevelID3 | int | Level 3 code |

### dbo.ProjectLevel
Project hierarchy levels.

---

## Revenue Collections Tables

### dbo.Receipt
Cash receipts.

| Column | Type | Description |
|--------|------|-------------|
| ReceiptID | int | Primary key |
| ReceiptNumber | varchar | Receipt # |
| ReceiptBatchID | int | Batch |
| CashierID | int | Cashier |
| PaymentDate | datetime | Payment date |
| GLDate | datetime | GL date |
| CentralNameID | int | Payer |
| VoidedStatusFlag | bit | Voided |

### dbo.ReceiptTransaction
Receipt line items.

---

## Shared Reference Tables

### dbo.CentralName
Central name/address table used across modules.

| Column | Type | Description |
|--------|------|-------------|
| CentralNameID | int | Primary key |
| LastName | varchar | Last name / Business name |
| FirstName | varchar | First name |
| MiddleName | varchar | Middle name |
| DateOfBirth | datetime | DOB |
| SSN | varchar | SSN (encrypted) |
| FederalTaxID | varchar | FEIN |
| PrimaryPhone | varchar | Phone |

### dbo.CommonNameAddress
Addresses linked to CentralName.

### dbo.OrgStructure
Organization/department hierarchy.

---

## Common Query Patterns

### Find Account by Code
```sql
SELECT GLAccountID, GLAccountDelimitedFull 
FROM dbo.GLAccount 
WHERE GLAccountDelimitedFull LIKE '%110.3500%330%'
```

### Current FY Expenses for Account
```sql
SELECT SUM(Amount) as Expenses
FROM dbo.JournalDetail
WHERE GLAccountID = 1116
  AND FiscalEndYear = 2026
  AND Source NOT IN ('BudgetProcessing')
  AND Source NOT LIKE 'BA %'
```

### Transaction Detail
```sql
SELECT GLDate, Source, Description, Amount
FROM dbo.JournalDetail
WHERE GLAccountID = 1116
  AND FiscalEndYear = 2026
ORDER BY GLDate
```

### Vendor Lookup
```sql
SELECT v.VendorNumber, cn.LastName, cn.FirstName
FROM dbo.Vendor v
JOIN dbo.CentralName cn ON v.CentralNameID = cn.CentralNameID
WHERE v.ActiveFlag = 1
```

### Open Purchase Orders
```sql
SELECT PONumber, VendorID, GLDate
FROM dbo.PurchaseOrder
WHERE ProcessStatus NOT IN (5, 6)  -- Not closed/voided
  AND FiscalYear = 2026
```

---

## Critical Notes

1. **ALWAYS filter by FiscalEndYear** for current balances
2. **Separate Budget from Expenses** using Source field
3. **Account format has space**: "110.3500 330.50" not "110.3500.330.50"
4. **Use CentralNameID** to link names across modules
5. **Check EffectiveEndDate IS NULL** or `= '9999-12-31'` for current HR records
6. **Check ActiveFlag** for master records
7. **ProcessStatus codes** vary by table - check valid values
8. **IGNORE CD and MCD schemas** - Community Development and Inspections not used

---

## Value Set Prefixes

Many columns use `vs` prefix indicating value set lookups:
- `vsType`, `vsStatus`, `vsCategory` etc.
- These are foreign keys to validation set tables
- Use `dbo.ValidationSetEntry` to decode values
