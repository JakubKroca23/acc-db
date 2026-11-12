# .agents — index paměti (acc-db)

Projektová paměť pro AI agenty. Žádné skill pluginy — jen odkazy.

## Primární

1. [`../AGENTS.md`](../AGENTS.md) — co dělat / nedělat
2. [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)
3. [`../docs/DATA-MODEL.md`](../docs/DATA-MODEL.md)
4. [`../docs/DEPLOY.md`](../docs/DEPLOY.md)
5. [`../README.md`](../README.md) — lidský quickstart

## Rozhodnutí (2026-11)

- Katalogová data: **PostgreSQL**, ne Appwrite TablesDB
- Auth Manager: Appwrite session cookie zůstává
- Soft-delete produktů (`is_active`), ne hard DELETE
- AI chat (Kapitán Karel / Ollama / Groq / Gemini) **odstraněn**

## Second brain (Obsidian)

Hledej `acc-db` přes `sb search`. Po významné práci: `sb capture … --sync`.
