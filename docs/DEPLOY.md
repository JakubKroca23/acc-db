# acc-db — deploy

## Produkce

- Host: `zakazky.contsystem.cz/acc-db/`
- Path na VPS: `/home/ubuntu/contsystem/acc-db`
- CI: push `main` → `.github/workflows/deploy.yml` → `vps.yml`

```bash
cd /home/ubuntu/contsystem/acc-db
git pull --ff-only
docker compose up -d --build
```

## Compose

Služby:

- **`postgres`** — `postgres:16-alpine`, healthcheck `pg_isready`, volume `acc-db-pg`, port `127.0.0.1:54331:5432`
- **`app`** — Vite preview `:4173`, `depends_on: condition: service_healthy`, Traefik labels, síť `appwrite` (+ interní `acc-db` k Postgres)

## Env (`.env` na serveru)

Povinné datové:

```
DATABASE_URL=postgres://acc:HESLO@postgres:5432/acc_db
POSTGRES_USER=acc
POSTGRES_PASSWORD=…
POSTGRES_DB=acc_db
ACC_DB_UPDATE_TOKEN=…
```

Auth (Manager):

```
ACC_DB_AUTH=manager
ACC_DB_ALLOWED_ROLES=*
MANAGER_AUTH_URL=http://cs-zakazky-app:3000
```

`MANAGER_AUTH_URL` je interní adresa kontejneru Manageru (Better Auth `GET /api/auth/session`). Katalogová data z Appwrite se nečtou.

## První seed

```bash
docker compose exec app npm run seed
# nebo z UI: Aktualizovat katalog
```

## Lokální vývoj

```bash
cp .env.example .env
# buď bez DATABASE_URL → JSON fallback
# nebo: docker compose up -d postgres  + DATABASE_URL=postgres://acc:acc@127.0.0.1:54331/acc_db
npm install
npm run seed   # jen s DATABASE_URL
npm run dev
```
