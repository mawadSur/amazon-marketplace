# Wiring Supabase Postgres to this Prisma app

This app uses Supabase **only as a hosted Postgres database**. Prisma connects to it
through two connection strings. `prisma/schema.prisma` already declares:

```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")   // pooled — used by the running app
  directUrl = env("DIRECT_URL")     // direct — used by prisma migrate deploy
}
```

You only need to set `DATABASE_URL` and `DIRECT_URL` in the environment.

---

## 1. The two connection strings

Both come from the Supabase dashboard: **Project Settings → Database → Connection string**
(select the **URI** / Prisma tab, "View parameters" reveals host/port). Use the **pooler**
endpoints — do **not** use the raw `db.<PROJECT_REF>.supabase.co` host: it is **IPv6-only**,
and AWS Fargate egresses over an **IPv4 NAT**, so a direct IPv6 dbhost is unreachable from
our containers.

### `DATABASE_URL` — Transaction pooler (port **6543**)

Used by the running Next.js app (many short-lived connections). This is the Supavisor/
PgBouncer transaction-mode pooler. Prisma **requires** the pgbouncer flags on this URL:

- `?pgbouncer=true` — tells Prisma the target is a transaction-mode pooler, so it disables
  prepared statements (which pgbouncer transaction mode cannot hold across statements).
- `&connection_limit=1` — each serverless/Fargate instance keeps a single client connection,
  letting the pooler fan out safely instead of exhausting Postgres.

### `DIRECT_URL` — Session pooler (port **5432**)

Used by `prisma migrate deploy` (and `prisma db push`/introspection). Migrations run DDL and
need a real session (advisory locks, prepared statements) that transaction pooling can't
provide, so they must **not** go through port 6543. Use the **Session pooler** endpoint,
which is **IPv4-compatible** — this matters because, as noted above, Fargate has no IPv6
route to the raw db host. No `pgbouncer` suffix here.

---

## 2. SSL mode

Supabase requires TLS. Append `sslmode=require` to both URLs. (Supabase presents a valid
cert chain, so `require` is sufficient; you do not need `verify-full` or a downloaded CA
bundle for this app.)

---

## 3. What you do NOT need

For this app, Supabase is **strictly the Postgres database**. The rest of the stack does not
touch Supabase:

- **Prisma** is the data layer — not the `@supabase/supabase-js` client.
- **NextAuth** handles auth — not Supabase Auth.
- **S3 / Cloudflare R2** handles file storage — not Supabase Storage.

Therefore the Supabase **anon key**, **service_role key**, and **project URL**
(`https://<PROJECT_REF>.supabase.co`) are **not required** and should not be added to the
environment. Only add them later if you deliberately adopt Supabase Auth, Storage, Realtime,
or the JS client.

---

## 4. Filled example (`.env`)

Replace `<PROJECT_REF>`, `<PASSWORD>`, and `<REGION>` (e.g. `us-east-1`) with your project's
values from the dashboard. Note both pooler hosts are `<REGION>.pooler.supabase.com` and the
username is `postgres.<PROJECT_REF>` (project-qualified for the pooler).

```dotenv
# Transaction pooler (6543) — app runtime. pgbouncer flags are mandatory for Prisma.
DATABASE_URL="postgresql://postgres.<PROJECT_REF>:<PASSWORD>@aws-0-<REGION>.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1&sslmode=require"

# Session pooler (5432, IPv4-compatible) — prisma migrate deploy.
DIRECT_URL="postgresql://postgres.<PROJECT_REF>:<PASSWORD>@aws-0-<REGION>.pooler.supabase.com:5432/postgres?sslmode=require"
```

> URL-encode any special characters in `<PASSWORD>` (e.g. `@` → `%40`, `#` → `%23`).

### Apply

```bash
# One-time / on deploy — runs against DIRECT_URL (session pooler, 5432)
npx prisma migrate deploy

# App runtime uses DATABASE_URL (transaction pooler, 6543) automatically
npm run build && npm start
```
