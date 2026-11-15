# Where a database runs: cloud providers

The new-database form asks "Where it runs" for every engine a cloud is listed
for (`DATA_CLOUD_PROVIDERS` in `packages/core/src/schemas/data-engines.ts`). A
provider is either connected to (the user pastes what the provider gave them)
or, where its API documents a create usable with the user's own key, created
by Polaris (`create: true`, driven by `apps/web/src/lib/data-cloud/service.ts`).

| Engine     | Provider       | Polaris creates it | API used                            |
| ---------- | -------------- | ------------------ | ----------------------------------- |
| PostgreSQL | Neon           | yes                | Neon API v2 (`data-cloud/neon.ts`)  |
| PostgreSQL | Supabase       | yes                | Management API (`supabase.ts`)      |
| MongoDB    | MongoDB Atlas  | no, connect only   | -                                   |
| Redis      | Upstash        | yes                | Developer API (`upstash.ts`)        |
| RabbitMQ   | CloudAMQP      | yes                | customer API (`cloudamqp.ts`)       |
| ClickHouse | ClickHouse Cloud, Aiven | no, connect only | -                          |

Every create stores the key in the row's encrypted credentials, takes one step
at a time from what the row holds (so a restart carries on), and deletes what
it created when the row is deleted.

## Decisions

### Firebase: not a place a database runs

Firebase's databases are Firestore and the Realtime Database, document stores
with their own SDKs and no wire protocol any engine in Polaris speaks. Data
Connect is GraphQL over a Cloud SQL instance that Firebase manages, not a
PostgreSQL host that hands over a connection string. None of it can stand in
for a PostgreSQL, MongoDB or Redis an app reaches with `DATABASE_URL`, so it is
not offered as a hosting choice.

### Upstash: Redis only

Upstash's products are Redis, Vector, QStash, Workflow, Search, Box and Blob.
Its Developer API documents provisioning for Redis and Vector only
(https://upstash.com/docs/devops/developer-api/introduction).

- **Redis** maps to Polaris's Redis engine, so Upstash is a place it runs.
- **Vector** has a provisioning API, but Polaris has no vector engine for it to
  be a place of. It could be offered once one exists.
- **QStash and Workflow** are HTTP message delivery and durable functions, not
  a broker a Kafka or RabbitMQ client can talk to.
- **Search, Box and Blob** have no provisioning API in the Developer API docs.

### MongoDB Atlas: connect only, for now

The Atlas Admin API v2 documents flex cluster create, read and delete, database
users and the IP access list, with service-account or digest auth. The pages we
could read do not spell out the fields inside `providerSettings` or
`connectionStrings`, which a create depends on, so Polaris does not guess them.
Atlas is offered to connect with a `mongodb+srv://` string. Before connecting,
allow this server's address in Atlas's IP access list.

### What each create cannot do yet

- **Neon** hands over the connection URI only in the create's answer. A create
  whose answer was lost (a restart at that moment) cannot be found again: the
  pages we read document no project search.
- **Supabase** does not document which status means ready; `ACTIVE_HEALTHY` is
  taken as ready. The URL is built from the pooler's `db_user`, `db_host`,
  `db_port` and `db_name` and the password Polaris chose, because the docs do
  not say whether `connection_string` carries the password.
- **Upstash** is read through the database list, since the docs we read do not
  show a single-database read.

None of these flows has been run against the real APIs.
