# Animal Shelter Database Domain Knowledge

## Overview
This database tracks **shelter operations and adoptions**. The primary use cases are:
- Tracking animals currently in the shelter
- Recording intakes and outcomes (adoptions, transfers, euthanasia, returns to owner)
- Managing kennel assignments

**Note:** This system is NOT used for field calls for service, complaints, or violation enforcement. Those features exist in the database but are not actively used.

## Schema Note
- **On-premises (DS6):** Tables are in `SYSADM` schema
- **Azure SQL (chatbot):** Tables are in `dbo` schema (translated during sync)

For the chatbot, use `dbo.table_name` (e.g., `dbo.kennel`, `dbo.animal`).

---

## Core Tables and Relationships

### kennel (Primary Operations Table)
The most important table - tracks ALL animal shelter transactions (intakes, outcomes, and current status).

| Column | Type | Description |
|--------|------|-------------|
| kennel_no | varchar | Physical kennel location OR special tracking code ('LOST', 'FOUND') |
| kennel_stat | varchar | Current status: AVAILABLE, EVALUATION, STRAY WAIT, UNAVAIL |
| animal_id | varchar | FK to animal table |
| owner_id | varchar | FK to person table |
| intake_type | varchar | How animal arrived |
| intake_date | datetime | When animal arrived |
| outcome_type | varchar | How animal left (NULL if still in shelter) |
| outcome_date | datetime | When animal left (NULL if still in shelter) |

### animal (Animal Master Records)
Static information about each animal.

| Column | Type | Description |
|--------|------|-------------|
| animal_id | varchar | Primary key |
| animal_name | varchar | Animal's name |
| animal_type | varchar | DOG, CAT, BIRD, LIVESTOCK, OTHER |
| sex | varchar | Animal's sex |
| primary_breed | varchar | Primary breed |
| secondary_breed | varchar | Secondary breed |
| primary_color | varchar | Primary color |
| animal_stat | varchar | Current overall status |

### person (People - Owners, Contacts, etc.)
| Column | Type | Description |
|--------|------|-------------|
| person_id | varchar | Primary key |
| last_name | varchar | Last name |
| first_name | varchar | First name |
| street_no, street_name, city, state, zip_code | various | Address components |
| phone_number | varchar | Phone |

---

## CRITICAL: Counting Animals Currently in Shelter

**DO NOT simply count `WHERE outcome_date IS NULL`** - this includes ~13,000 LOST/FOUND tracking records!

### Correct Query for Animals Physically in Shelter:
```sql
SELECT COUNT(*) 
FROM dbo.kennel 
WHERE outcome_date IS NULL 
  AND kennel_no NOT IN ('LOST', 'FOUND')
```

### With Animal Type Breakdown:
```sql
SELECT a.animal_type, COUNT(*) as count
FROM dbo.kennel k
JOIN dbo.animal a ON k.animal_id = a.animal_id
WHERE k.outcome_date IS NULL 
  AND k.kennel_no NOT IN ('LOST', 'FOUND')
GROUP BY a.animal_type
```

### Understanding kennel_no Values:
- **'LOST'** - Lost animal reports (NOT physically in shelter)
- **'FOUND'** - Found animal reports (NOT physically in shelter)  
- **'C01'-'C99', 'D01'-'D99', etc.** - Physical kennel cage numbers
- **'RECEIVING'** - Intake area

---

## Code Values and Their Meanings

### outcome_type (How animals leave the shelter)
| Code | Meaning |
|------|---------|
| ADOPTION | Adopted to new owner |
| EUTH | Euthanized |
| DIED | Died while in care |
| RTO | Return to Owner |
| RTF | Return to Field (TNR programs) |
| TRANSFER | Transferred to another agency |
| FOSTER | Placed in foster care |
| RELOCATE | Relocated |
| DISPOSAL | Body disposal |
| MISSING | Animal went missing |

### intake_type (How animals arrive)
| Code | Meaning |
|------|---------|
| STRAY | Picked up as stray |
| OWNER SUR | Owner surrender |
| CONFISCATE | Confiscated/seized |
| RETURN | Returned after adoption/foster |
| TRANSFER | Transferred from another agency |
| FOSTER | Coming from foster |
| BORN IN CA | Born in care |
| EUTH REQ | Euthanasia request |
| DISPO REQ | Disposal request |

### kennel_stat (Current status while in shelter)
| Code | Meaning |
|------|---------|
| AVAILABLE | Available for adoption |
| STRAY WAIT | Stray hold period |
| EVALUATION | Being evaluated |
| UNAVAIL | Not available |

### animal_type
| Code | Meaning |
|------|---------|
| DOG | Dog |
| CAT | Cat |
| BIRD | Bird |
| LIVESTOCK | Livestock |
| OTHER | Other animals |

---

## Common Query Patterns

### Euthanasia Count Since Date
```sql
SELECT COUNT(*) as euthanized
FROM dbo.kennel
WHERE outcome_type = 'EUTH'
  AND outcome_date >= '2025-01-01'
```

### Euthanasia by Animal Type
```sql
SELECT a.animal_type, COUNT(*) as count
FROM dbo.kennel k
JOIN dbo.animal a ON k.animal_id = a.animal_id
WHERE k.outcome_type = 'EUTH'
  AND k.outcome_date >= '2025-01-01'
GROUP BY a.animal_type
```

### Outcomes Summary for Date Range
```sql
SELECT outcome_type, COUNT(*) as count
FROM dbo.kennel
WHERE outcome_date >= '2024-01-01'
  AND outcome_date < '2025-01-01'
GROUP BY outcome_type
ORDER BY count DESC
```

### Intakes by Type
```sql
SELECT intake_type, COUNT(*) as count
FROM dbo.kennel
WHERE intake_date >= '2025-01-01'
GROUP BY intake_type
ORDER BY count DESC
```

### Monthly Intake/Outcome Trends
```sql
SELECT 
    YEAR(intake_date) as year,
    MONTH(intake_date) as month,
    COUNT(*) as intakes
FROM dbo.kennel
WHERE intake_date >= '2024-01-01'
GROUP BY YEAR(intake_date), MONTH(intake_date)
ORDER BY year, month
```

---

## Other Tables (Limited Use)

The following tables exist but are NOT actively used in current operations:

- **bite** - Bite incident tracking (not used)
- **violation** - Code violations/citations (not used - no field calls for service)
- **tag** - Pet licensing (exists but limited use)
- **treatment** - Medical treatments (exists but limited use)
- **complaint** - Complaints (not used)

These tables may contain historical data but should not be the focus of queries about current operations.

---

## Key Relationships

```
person (person_id) <-- kennel (owner_id)
person (person_id) <-- bite (victim_id, owner_id)
person (person_id) <-- violation (defendant_id)
person (person_id) <-- tag (person_id)

animal (animal_id) <-- kennel (animal_id)
animal (animal_id) <-- bite (animal_id)
animal (animal_id) <-- treatment (animal_id)
animal (animal_id) <-- tag (animal_id)
```

---

## Date Handling Notes

- Always use ISO format: `'YYYY-MM-DD'`
- For "current year" queries, use: `YEAR(GETDATE())`
- For date ranges, use: `>= 'start' AND < 'end'` (exclusive end)
- Some records have bad date data (e.g., year 3025) - filter appropriately if needed
