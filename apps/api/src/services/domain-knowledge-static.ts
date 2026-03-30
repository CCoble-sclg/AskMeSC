// Static domain knowledge - embedded directly in the prompt for fastest performance

export const ANIMAL_DB_KNOWLEDGE = `
# Animal Shelter Database

## Overview
Tracks shelter operations and adoptions. Tables in dbo schema.
NOT used for field calls for service, complaints, or violations.

## Core Tables

### kennel (Primary Table)
| Column | Description |
|--------|-------------|
| kennel_no | Physical location OR 'LOST'/'FOUND' tracking codes |
| animal_id | FK to animal |
| owner_id | FK to person |
| intake_type | How arrived: STRAY, OWNER SUR, CONFISCATE, RETURN, TRANSFER |
| intake_date | When arrived |
| outcome_type | How left: ADOPTION, EUTH, DIED, RTO, TRANSFER, FOSTER (NULL if still in shelter) |
| outcome_date | When left (NULL if still in shelter) |
| kennel_stat | Status: AVAILABLE, STRAY WAIT, EVALUATION, UNAVAIL |

### animal
| Column | Description |
|--------|-------------|
| animal_id | Primary key |
| animal_name | Name |
| animal_type | DOG, CAT, BIRD, LIVESTOCK, OTHER |
| primary_breed, secondary_breed | Breeds |
| primary_color | Color |

### person
| Column | Description |
|--------|-------------|
| person_id | Primary key |
| first_name, last_name | Name |
| street_no, street_name, city, state, zip_code | Address |

## CRITICAL: Counting Animals in Shelter

**NEVER just use WHERE outcome_date IS NULL** - includes ~13,000 LOST/FOUND reports!

CORRECT:
SELECT COUNT(*) FROM dbo.kennel 
WHERE outcome_date IS NULL AND kennel_no NOT IN ('LOST', 'FOUND')

With animal type:
SELECT a.animal_type, COUNT(*) as count
FROM dbo.kennel k JOIN dbo.animal a ON k.animal_id = a.animal_id
WHERE k.outcome_date IS NULL AND k.kennel_no NOT IN ('LOST', 'FOUND')
GROUP BY a.animal_type

## Code Values
- outcome_type: ADOPTION, EUTH (euthanasia), DIED, RTO (return to owner), TRANSFER, FOSTER
- intake_type: STRAY, OWNER SUR, CONFISCATE, RETURN, TRANSFER, BORN IN CA
- kennel_stat: AVAILABLE, STRAY WAIT, EVALUATION, UNAVAIL
`;

export const LOGOS_DB_KNOWLEDGE = `
# Logos ERP Database (Tyler Munis)

## Overview
Government ERP: Finance, HR, Utility Billing, Purchasing.
- Main tables: dbo schema
- HR tables: HR schema
- IGNORE: CD schema (Community Development), MCD schema (Inspections)

## CRITICAL: Budget vs Expenses

JournalDetail.Source determines if entry is Budget or Expense:
- BUDGET: Source = 'BudgetProcessing' OR Source LIKE 'BA %'
- EXPENSES: All other Source values

NEVER just SUM(Amount)! Use this pattern:
SELECT 
  SUM(CASE WHEN Source = 'BudgetProcessing' OR Source LIKE 'BA %' THEN Amount ELSE 0 END) as Budget,
  SUM(CASE WHEN Source NOT IN ('BudgetProcessing') AND Source NOT LIKE 'BA %' THEN Amount ELSE 0 END) as Expenses,
  SUM(CASE WHEN Source = 'BudgetProcessing' OR Source LIKE 'BA %' THEN Amount ELSE 0 END) -
  SUM(CASE WHEN Source NOT IN ('BudgetProcessing') AND Source NOT LIKE 'BA %' THEN Amount ELSE 0 END) as Balance
FROM dbo.JournalDetail WHERE GLAccountID = X AND FiscalEndYear = 2026

## Core Financial Tables

### dbo.JournalDetail (Main Transaction Table)
| Column | Description |
|--------|-------------|
| GLAccountID | FK to GLAccount |
| FiscalEndYear | ALWAYS filter by this! |
| Amount | Transaction amount |
| Source | CRITICAL: Budget vs Expense indicator |
| GLDate | Transaction date |

### dbo.GLAccount
| Column | Description |
|--------|-------------|
| GLAccountID | Primary key |
| GLAccountDelimitedFull | Human-readable (e.g., "110.3500 330.50") |
| Org1Code | Fund code |

### dbo.Organization1 (Funds)
| Column | Description |
|--------|-------------|
| OrganizationID | Primary key |
| OrganizationCode | Fund code (110, 210, etc.) |
| Description | Fund name |

## Human Resources Tables

### HR.EmployeeEmployment (Employment Status)
| Column | Description |
|--------|-------------|
| EmployeeId | FK to Employee |
| EffectiveDate | Start/hire date |
| EffectiveEndDate | End date (9999-12-31 = current) |
| vsEmploymentStatusId | 518=ACTIVE, 519=TERMINATED, 517=Leave, 520=Retired |
| TerminationDate | Termination date |

### HR.EmployeeName
| Column | Description |
|--------|-------------|
| EmployeeId | FK to Employee |
| FirstName, LastName | Name |
| EffectiveEndDate | NULL or 9999-12-31 = current |

### HR.EmployeeJob
| Column | Description |
|--------|-------------|
| EmployeeId | FK to Employee |
| Title | Job title |
| DepartmentID | FK to dbo.OrgStructure.OrgStructureID |
| IsPrimaryJob | 1 = primary position |
| EffectiveEndDate | 9999-12-31 = current |
NOTE: EmployeeJob does NOT have salary columns. Use the salary function below.

### HR.fn_GetEmployee_Base_ProjectedSalary_ByDate (Table-Valued Function for Salary)
Call as: HR.fn_GetEmployee_Base_ProjectedSalary_ByDate(GETDATE(), NULL)
| Column | Description |
|--------|-------------|
| EmployeeId | FK to Employee |
| HourlyRate | Hourly pay rate |
| ProjectedAnnualSalary | Annual salary |
LEFT JOIN like a table:
LEFT JOIN HR.fn_GetEmployee_Base_ProjectedSalary_ByDate(GETDATE(), NULL) ePay ON ePay.EmployeeId = e.EmployeeId

### dbo.OrgStructure (Department Structure)
| Column | Description |
|--------|-------------|
| OrgStructureID | Primary key (matches HR.EmployeeJob.DepartmentID) |
| Level1ID | FK to dbo.OrgGroup.OrgGroupID (this is the DEPARTMENT level) |

### dbo.OrgGroup (Department Names)
| Column | Description |
|--------|-------------|
| OrgGroupID | Primary key |
| OrgGroupCodeDesc | Department name (e.g., "Elections", "Finance", "Public Works (Operating)") |

IMPORTANT: When users ask about a department, use the FULL department name in OrgGroupCodeDesc.
Common mappings:
- "IT" = "Information Technology"
- Do NOT use LIKE '%IT%' - use OrgGroupCodeDesc = 'Information Technology' or LIKE '%Information Technology%'

### HR.EmployeeDemographics (Personal Info)
| Column | Description |
|--------|-------------|
| EmployeeId | FK to Employee |
| DateOfBirth | Date of birth (use this for age calculations, NOT BirthDate) |
| vsGender | Gender code |
| EmployeeSSN | SSN (do NOT select this - sensitive data) |

## CRITICAL: Getting Department Name for Employees

To get department names, you MUST join through OrgStructure to OrgGroup:
  HR.EmployeeJob.DepartmentID -> dbo.OrgStructure.OrgStructureID -> dbo.OrgGroup via OrgStructure.Level1ID = OrgGroup.OrgGroupID

## Key HR Queries

Active employee count:
SELECT COUNT(DISTINCT EmployeeId) FROM HR.EmployeeEmployment
WHERE vsEmploymentStatusId = 518 AND EffectiveEndDate = '9999-12-31'

Employees hired since date (with department):
SELECT en.FirstName, en.LastName, ee.EffectiveDate as HireDate, ej.Title, og.OrgGroupCodeDesc as Department
FROM HR.EmployeeEmployment ee
JOIN HR.Employee e ON ee.EmployeeId = e.EmployeeId
JOIN HR.EmployeeName en ON e.EmployeeId = en.EmployeeId
JOIN HR.EmployeeJob ej ON e.EmployeeId = ej.EmployeeId
INNER JOIN dbo.OrgStructure os ON ej.DepartmentID = os.OrgStructureID
INNER JOIN dbo.OrgGroup og ON os.Level1ID = og.OrgGroupID
WHERE ee.EffectiveDate >= '2026-01-01' AND ee.vsEmploymentStatusId = 518
  AND ee.EffectiveEndDate = '9999-12-31'
  AND en.EffectiveEndDate = '9999-12-31'
  AND ej.EffectiveEndDate = '9999-12-31' AND ej.IsPrimaryJob = 1

Employees with salary (with department):
SELECT en.FirstName, en.LastName, ej.Title, og.OrgGroupCodeDesc as Department,
  ePay.HourlyRate, ePay.ProjectedAnnualSalary as [Annual Salary]
FROM HR.Employee e
JOIN HR.EmployeeEmployment ee ON e.EmployeeId = ee.EmployeeId
JOIN HR.EmployeeName en ON e.EmployeeId = en.EmployeeId
JOIN HR.EmployeeJob ej ON e.EmployeeId = ej.EmployeeId
INNER JOIN dbo.OrgStructure os ON ej.DepartmentID = os.OrgStructureID
INNER JOIN dbo.OrgGroup og ON os.Level1ID = og.OrgGroupID
LEFT JOIN HR.fn_GetEmployee_Base_ProjectedSalary_ByDate(GETDATE(), NULL) ePay ON ePay.EmployeeId = e.EmployeeId
WHERE ee.vsEmploymentStatusId = 518 AND ee.EffectiveEndDate = '9999-12-31'
  AND en.EffectiveEndDate = '9999-12-31'
  AND ej.EffectiveEndDate = '9999-12-31' AND ej.IsPrimaryJob = 1

## Other Tables

### dbo.Vendor
VendorID, VendorNumber, CentralNameID (join to CentralName for name), ActiveFlag

### dbo.CentralName
CentralNameID, FirstName, LastName (shared name/address table)

### dbo.PurchaseOrder
PurchaseOrderID, PONumber, VendorID, FiscalYear, ProcessStatus

## Utility Billing Tables

IMPORTANT: For utility billing questions (average bill, bill amounts, billing history),
use the Utility tables below. Do NOT use JournalDetail for utility billing queries.

### dbo.UtilityAccount (Customer Accounts)
| Column | Description |
|--------|-------------|
| UtilityAccountID | Primary key |
| AccountNumber | Customer-facing account number |
| AccountStatus | 1=Active, 2=Inactive |

### dbo.UtilityTransactionHeader (Transaction Headers)
| Column | Description |
|--------|-------------|
| UTTransHeaderID | Primary key |
| BillingCycleID | FK to billing cycle |
| TransactionType | 1=Bill, 3=Penalty |

### dbo.UtilityTransactionSummary (Transaction Amounts)
| Column | Description |
|--------|-------------|
| UTTransSummaryID | Primary key |
| UTTransHeaderID | FK to UtilityTransactionHeader |
| UtilityAccountID | FK to UtilityAccount |
| ExceptionBillID | FK to ExceptionBills (for special bills) |
| TransSummaryAmount | Dollar amount (the actual bill/payment amount) |
| ParentUTTransSummaryID | Links payments to their parent bill |
| Ver | Version (ALWAYS filter Ver = 1 for current records) |

### dbo.BillingManager (Billing Cycle Dates)
| Column | Description |
|--------|-------------|
| BillingCycleID | Billing cycle identifier |
| BillingEventType | 1=Bill Date, 5=Statement Date |
| EventDate | Date of the event |

## Key Utility Billing Queries

Average bill amount per billing cycle:
SELECT AVG(CycleBill) as AvgBillAmount, COUNT(*) as NumCycles
FROM (
  SELECT H.BillingCycleID, SUM(S.TransSummaryAmount) as CycleBill
  FROM dbo.UtilityTransactionHeader H
  JOIN dbo.UtilityTransactionSummary S ON S.UTTransHeaderID = H.UTTransHeaderID
  WHERE H.TransactionType = 1 AND S.Ver = 1
  GROUP BY H.BillingCycleID
) bills

Average bill per customer account:
SELECT AVG(AcctTotal) as AvgBillPerAccount
FROM (
  SELECT S.UtilityAccountID, SUM(S.TransSummaryAmount) as AcctTotal
  FROM dbo.UtilityTransactionHeader H
  JOIN dbo.UtilityTransactionSummary S ON S.UTTransHeaderID = H.UTTransHeaderID
  WHERE H.TransactionType = 1 AND S.Ver = 1
  GROUP BY S.UtilityAccountID
) accts

Bills by date range (using BillingManager for dates):
SELECT BM.EventDate as BillDate, SUM(S.TransSummaryAmount) as TotalBilled
FROM dbo.UtilityTransactionHeader H
JOIN dbo.UtilityTransactionSummary S ON S.UTTransHeaderID = H.UTTransHeaderID
JOIN dbo.BillingManager BM ON BM.BillingCycleID = H.BillingCycleID AND BM.BillingEventType = 1
WHERE H.TransactionType = 1 AND S.Ver = 1
  AND BM.EventDate >= '2026-01-01'
GROUP BY BM.EventDate
ORDER BY BM.EventDate
`;
