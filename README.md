# Time-Off Microservice

A backend microservice for managing employee time-off requests and syncing leave balances with an HCM system (Workday, SAP). Built with NestJS and SQLite.

See [TRD.md](TRD.md) for the full Technical Requirements Document including design decisions, failure modes, and data model.

---

## Architecture

```
[Employee / Manager Browser]
           │
           │  JWT token
           ▼
     [API Gateway]  ←── validates JWT, sets X-User-Role and X-User-Id headers
           │
           │  X-User-Role, X-User-Id (trusted headers)
           ▼
[Time-Off Microservice :3000]
      │              │
      │              ▼
      │         [SQLite DB]
      │         ├── time_off_request
      │         ├── time_off_balance   (cache + pending holds)
      │         └── balance_sync_log   (audit trail)
      │
      ▼
 [HCM System :3001]
 ├── GET    /hcm/balance           ← read current balance (realtime)
 ├── GET    /hcm/balance/batch     ← full corpus (batch sync, every 6h)
 ├── POST   /hcm/time-off          ← commit approved request
 └── DELETE /hcm/time-off/:id      ← cancel approved request
```

In local development and tests, the HCM system is replaced by the **Mock HCM server** — a lightweight NestJS app that simulates Workday/SAP with controllable state.

---

## Quick Start (Docker — recommended)

```bash
docker compose up
```

- Main service: `http://localhost:3000`
- Mock HCM: `http://localhost:3001`

```bash
docker compose down
```

---

## Manual Start (npm)

Requires Node.js 20+. Run each in a separate terminal.

**Terminal 1 — Mock HCM:**
```bash
npm install
npm run start:mock-hcm
# Running on http://localhost:3001
```

**Terminal 2 — Main service:**
```bash
npm run start:dev
# Running on http://localhost:3000
```

---

## Running Tests

The E2E tests start the mock HCM programmatically — no need to run it separately.

```bash
# Unit + integration tests
npm run test

# Unit tests only
npm run test:unit

# Integration tests only
npm run test:integration

# E2E tests (mock HCM started automatically)
npm run test:e2e
```

Docker (fully isolated):
```bash
docker compose -f docker-compose.test.yml up --abort-on-container-exit --exit-code-from test
```

---

## Authorization Headers

All endpoints require two headers forwarded by the API gateway:

| Header | Values | Description |
|---|---|---|
| `X-User-Role` | `employee`, `manager`, `admin` | Role of the authenticated user |
| `X-User-Id` | e.g. `employee-1` | ID of the authenticated user |

Missing `X-User-Role` → 401. Wrong role for the endpoint → 403. Employee accessing another employee's data → 403.

---

## API Endpoints

### Employee

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/time-off/balance?employeeId=&locationId=` | Get balance. Live HCM fetch if cache is stale (>15 min). |
| `POST` | `/time-off/requests` | Submit a request. Requires `Idempotency-Key` header. |
| `GET` | `/time-off/requests?employeeId=` | List own requests. |
| `PATCH` | `/time-off/requests/:id/cancel` | Cancel a PENDING or APPROVED request. |

### Manager

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/time-off/requests/pending` | List all PENDING requests across all employees. |
| `PATCH` | `/time-off/requests/:id/approve` | Approve a request (commits deduction to HCM). |
| `PATCH` | `/time-off/requests/:id/reject` | Reject a request (releases pending hold). |

### Admin

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/admin/hcm/sync` | Trigger an immediate batch sync from HCM. |

---

## Example Requests

**Get balance:**
```bash
curl "http://localhost:3000/time-off/balance?employeeId=employee-1&locationId=location-1" \
  -H "X-User-Role: employee" \
  -H "X-User-Id: employee-1"
```

**Submit a request:**
```bash
curl -X POST http://localhost:3000/time-off/requests \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "X-User-Role: employee" \
  -H "X-User-Id: employee-1" \
  -d '{
    "employeeId": "employee-1",
    "locationId": "location-1",
    "startDate": "2026-07-01",
    "endDate": "2026-07-05",
    "daysRequested": 3
  }'
```

**Approve a request:**
```bash
curl -X PATCH http://localhost:3000/time-off/requests/<id>/approve \
  -H "X-User-Role: manager" \
  -H "X-User-Id: manager-1"
```

**Trigger batch sync:**
```bash
curl -X POST http://localhost:3000/admin/hcm/sync \
  -H "X-User-Role: admin" \
  -H "X-User-Id: admin-1"
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `HCM_BASE_URL` | `http://localhost:3001` | HCM server URL |
| `HCM_TIMEOUT_MS` | `5000` | Per-request timeout to HCM (ms) |
| `HCM_RETRY_COUNT` | `3` | Max retries on HCM failure |
| `HCM_BATCH_CRON` | `0 */6 * * *` | Batch sync schedule (every 6 hours) |
| `DATABASE_PATH` | `./data/timeoff.sqlite` | SQLite file path (`:memory:` in tests) |
| `BALANCE_STALENESS_THRESHOLD_MINUTES` | `15` | Minutes before cached balance triggers a live HCM fetch |
| `PORT` | `3000` | Main service port |

---

## Mock HCM

The mock HCM simulates Workday/SAP for local development and testing. It starts with this seed data:

| Employee | Location | Available Days |
|---|---|---|
| employee-1 | location-1 | 10 |
| employee-1 | location-2 | 5 |
| employee-2 | location-1 | 8 |

Test-control endpoints (not present in real HCM):

| Endpoint | Description |
|---|---|
| `POST /test/reset` | Reset state to seed data |
| `POST /test/set-error-mode` | Simulate HCM failures |
| `POST /test/set-silent-bad-balance` | Return 0 balance silently |
| `POST /test/simulate/anniversary` | Add bonus days to an employee |
| `POST /test/simulate/year-reset` | Reset all balances for a location |
| `GET /test/state` | Inspect current state |
