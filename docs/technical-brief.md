# Technical Brief

## Overview

A Progressive Web App (PWA) for calorie tracking, built for **radical simplicity**:

- Offline-first, installable PWA
- Local SQLite database persisted with **OPFS**
- Type-safe queries via **TypeOrm**
- Photo & screenshot capture stored in OPFS
- Direct OpenAI API integration with user-supplied key
- No backend

## Stack

- **Frontend:** Vite + React + TypeScript
- **Database:** SQLite via `@sqlite.org/sqlite-wasm` (OPFS VFS)
- **ORM / Type safety:** TypeOrm with wa-sqlite worker adapter
- **PWA:** Manifest + Service Worker (cache app shell, WASM, icons)
- **Storage:**
  - Photos/screenshots → OPFS file storage
  - Metadata (meals, exercises, settings) → SQLite
- **AI:** Fetch calls directly to OpenAI REST API using API key stored locally

## Data Flow

1. User takes photo/screenshot → saved in OPFS
2. Metadata record created in SQLite (title, timestamp, file path)
3. Photo + text sent to OpenAI API → calories/macros extracted
4. DB record updated with nutrition or exercise calories
5. Daily budget calculation = base_budget + exercise - meals

## Security

- API key stored locally in SQLite (encrypted if possible, else plain string)
- No backend → no server secrets to manage
- All personal data remains on device

## Maintenance

- Zero backend infrastructure
- Single-page app, deployed on static hosting (e.g., GitHub Pages, Netlify, Vercel)
- SQLite OPFS handles persistence natively in browser
