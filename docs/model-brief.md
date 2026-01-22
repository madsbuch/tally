# Model Brief (Simplified)

## Table: `entry`

- **id**: TEXT (UUID, PK)
- **created_at**: INTEGER (epoch ms)
- **type**: TEXT (`meal` | `exercise`)
- **title**: TEXT (optional, AI or user input)
- **notes**: TEXT (optional)
- **image_path**: TEXT (path in OPFS; meal photo or exercise screenshot)
- **thumb**: BLOB (small WebP thumbnail)
- **energy_kcal**: REAL
  - Positive for meals (intake)
  - Negative for exercises (burn)
- **protein_g**: REAL (optional, only relevant for meals)
- **carbs_g**: REAL (optional, only relevant for meals)
- **fat_g**: REAL (optional, only relevant for meals)

## Table: `config`

- **id**: INTEGER (singleton row = 1)
- **daily_budget_kcal**: INTEGER (default 1500)
- **openai_api_key**: TEXT (user-supplied, stored locally)

## Indices

- `idx_entry_created` on `entry.created_at`
