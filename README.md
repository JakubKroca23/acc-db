# Kalkulačka příslušenství vozidla

Jednoduchá webová utilita (mobil + desktop) pro výběr příslušenství a přibližný odhad nákladů.

Data jsou v **Appwrite** (`acc-db`):
- `accessories` — druhy příslušenství (Blatníky, Maják, …)
- `products` — konkrétní produkty s cenou, dodavatelem, rozměry a náhledem (ALSAP, Hydrotruck, …)

## Spuštění

```bash
cp .env.example .env   # doplň APPWRITE_API_KEY
npm install
npm run seed           # sync typů + produktů do Appwrite
npm run dev
```

Otevři http://localhost:5173

U každého druhu klikni **Přidat** → otevře se nápověda s filtrem (text + dodavatel), náhledy, rozměry a cenami.

## Poznámky

- Ceny jsou z veřejných katalogů / orientační — ne závazný ceník.
- Frontend čte data přes `/api/accessories` a `/api/products` (Vite middleware), API klíč zůstává na serveru.
- Vlastní výroba je zatím vypnutá.

Produkce: `https://zakazky.contsystem.cz/acc-db/` — deploy `docker compose up -d --build`
