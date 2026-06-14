# Technical Requirements Document — Time-Off Microservice

**Author:** ReadyOn AI Engineering  
**Status:** Final  

---

## 1. Problem Statement

ReadyOn serves as the primary interface for employees to request time off. The Human Capital Management (HCM) system (e.g. Workday, SAP) remains the authoritative source of truth for all employment and leave balance data.

**Design principle:** ReadyOn maintains a local balance cache for low-latency reads and local pending reservations, but HCM remains the source of truth. All balance-affecting writes fail closed unless ReadyOn can verify or commit the operation with HCM.

The core problem is **keeping balances consistent between two systems**. This is hard because:

- ReadyOn is not the only system writing to HCM — HR can make manual adjustments, anniversary bonuses can fire, year-start resets can run, all without ReadyOn's knowledge
- HCM should return errors for invalid requests (insufficient balance, bad dimensions) but this is not guaranteed — ReadyOn must be defensive
- Two employees (or the same employee from two browser tabs) could submit concurrent requests that both appear valid before either deduction is committed

---

## 2. Scope & Constraints

**In scope:**
- Time-off request lifecycle: submit, approve, reject, cancel
- Balance integrity: local cache, HCM sync, defensive validation
- HCM integration: realtime API calls and scheduled batch pull
- Race condition prevention
- Role-based authorization (employee, manager, admin)
- User-level scoping (employees can only access and act on their own data)

**Out of scope:**
- Authentication and JWT validation (assumed handled by an upstream API gateway)
- Push notifications to employees
- Calendar integrations

**Technical constraints:**
- NestJS + SQLite (via TypeORM)
- Balances are per-employee per-location (dimensions: `employeeId` + `locationId`)
- HCM is a black box — we integrate via its REST API

**Assumptions about HCM API surface:**

The brief specifies two HCM capabilities: a realtime API (get/submit balance values) and a batch endpoint. This design additionally assumes HCM exposes a **transaction cancellation endpoint** (`DELETE /hcm/time-off/:transactionId`) to reverse a previously committed time-off submission. This is consistent with how enterprise HCMs like Workday and SAP work in practice — retraction of an approved absence is a standard API operation — but it is not explicitly stated in the brief.

If the specific HCM integration does not support cancellation via API, cancel-of-APPROVED would degrade gracefully: ReadyOn would mark the request CANCELLED locally and leave `hcmAvailableBalance` unchanged. The balance would self-correct on the next batch sync once HR manually reverses the entry in the HCM. This fallback is documented in the Failure Modes table (section 8).

**Future extension (not in scope):** A third dimension `leaveType` (VACATION, SICK, PERSONAL) would be added in production to support separate leave buckets. The current model omits this to stay within the spec.

---

## 3. Key Challenges

### 3.1 Dual-system balance consistency

ReadyOn maintains a local balance cache for performance, but HCM is the source of truth. Any time ReadyOn writes a time-off decision, it must coordinate with HCM. If HCM rejects, ReadyOn must not commit the change locally.

### 3.2 Out-of-band HCM balance changes

HCM updates balances independently — work anniversaries add days, year-start resets refresh totals, HR makes manual corrections. ReadyOn has no real-time notification of these; it must periodically pull from HCM to stay current.

### 3.3 Unreliable HCM error signalling

HCM should reject requests against insufficient balance or invalid dimensions, but this is not guaranteed. ReadyOn must perform its own local validation before every write — it cannot trust that HCM will catch all errors.

### 3.4 Concurrent requests

Two requests submitted simultaneously for the same employee could both pass the balance check before either deduction is written. A naive implementation would allow over-commitment.

---

## 4. Data Model

### `time_off_balance`

| Column | Type | Notes |
|---|---|---|
| id | integer PK | |
| employeeId | varchar | |
| locationId | varchar | |
| hcmAvailableBalance | decimal | **Cache** — remaining balance as last reported by HCM. Overwritten on every sync or live fetch. Not the source of truth; HCM is. |
| pendingBalance | decimal | **Authoritative ReadyOn state** — days reserved for PENDING requests not yet committed to HCM. Exists nowhere else. |
| lastSyncedAt | datetime | When `hcmAvailableBalance` was last refreshed from HCM |
| version | integer | Optimistic lock counter — incremented on every write |
| — | UNIQUE(employeeId, locationId) | |

```
availableToReserve = hcmAvailableBalance (cached from HCM) - pendingBalance (owned by ReadyOn)
```

This table serves two distinct purposes in a single row:

**`hcmAvailableBalance` is a cache.** It mirrors what HCM last reported and is refreshed on every live fetch or batch sync. If HCM went down for a week this value would go stale, but that is tolerable — reads fall back to the cached value and writes re-fetch before proceeding.

**`pendingBalance` is not a cache.** It is ReadyOn-owned authoritative state that exists nowhere else in the system. HCM has no concept of a "pending" request — it only knows about committed, approved time-off. `pendingBalance` represents the sum of days held by all PENDING requests that are awaiting manager approval. If this value were lost, ReadyOn could over-commit the balance during the window between submission and approval.

The distinction matters operationally: `hcmAvailableBalance` can be reconstructed at any time by calling HCM. `pendingBalance` cannot — it must be derived from the `time_off_request` table (sum of `daysRequested` where `status = PENDING`) if it ever needs to be rebuilt.

### `time_off_request`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| idempotencyKey | varchar UNIQUE | Client-generated UUID; prevents duplicate submissions on retry |
| employeeId | varchar | |
| locationId | varchar | |
| startDate | date | |
| endDate | date | |
| daysRequested | decimal | Supplied by client; service does not derive from dates |
| status | enum | PENDING / APPROVED / REJECTED / CANCELLED |
| hcmTransactionId | varchar nullable | Returned by HCM on approval |
| note | varchar nullable | Optional note added on reject or cancel — visible to the employee |
| createdAt | datetime | |
| updatedAt | datetime | |

### `balance_sync_log`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| employeeId | varchar | |
| locationId | varchar | |
| source | enum | REALTIME_PULL / BATCH_CRON / BATCH_MANUAL |
| previousBalance | decimal | |
| newBalance | decimal | |
| syncedAt | datetime | |

---

## 5. REST API

### Employee endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/time-off/balance` | Get balance for `?employeeId=&locationId=`. Fetches fresh from HCM if local record is stale (>15 min). |
| `POST` | `/time-off/requests` | Submit a time-off request. Requires `Idempotency-Key` header. |
| `GET` | `/time-off/requests` | List requests for `?employeeId=`. Optional `?status=` filter (PENDING, APPROVED, REJECTED, CANCELLED). |
| `PATCH` | `/time-off/requests/:id/cancel` | Cancel a PENDING or APPROVED request. Optional `{ "note": "..." }` body. PENDING cancellations release the local pending hold only. APPROVED cancellations call HCM to reverse the committed transaction before updating local state. |

### Manager endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/time-off/requests/pending` | List all PENDING requests. |
| `PATCH` | `/time-off/requests/:id/approve` | Approve a request (triggers live HCM write). |
| `PATCH` | `/time-off/requests/:id/reject` | Reject a request (releases pending balance). Optional `{ "note": "..." }` body — visible to the employee on their request. |

### Admin endpoint

| Method | Path | Description |
|---|---|---|
| `POST` | `/admin/hcm/sync` | Trigger an immediate batch pull from HCM. |

---

## 6. Request Lifecycle

### POST /time-off/requests (submit)

1. Require `Idempotency-Key` header — return 400 if missing.
2. If a request with that key already exists, return it (idempotent retry).
3. Check for date overlap with existing PENDING or APPROVED requests for the same employee/location — return 422 if overlap found.
4. Call HCM realtime API to fetch fresh `hcmAvailableBalance`.
5. Check `availableToReserve = hcmAvailableBalance - pendingBalance >= daysRequested` — return 422 if insufficient.
6. SQLite transaction:
   - Insert `time_off_request` with status=PENDING.
   - `UPDATE time_off_balance SET pendingBalance += daysRequested, version = version + 1 WHERE version = :v` (optimistic lock).
   - If 0 rows updated → return 409 (concurrent write won the race; client retries from step 2).
7. Return 201 with the created request.

### PATCH /approve

1. Verify request is PENDING — return 422 otherwise.
2. Call HCM realtime API to re-fetch `hcmAvailableBalance` (balance may have changed since submission).
3. Pre-validate: `hcmAvailableBalance - pendingBalance >= daysRequested` — return 422 if insufficient (fast-fail, no HCM write yet).
4. Call HCM submit endpoint. HCM response is the final authority.
5. If HCM errors → return 422/503, leave local state unchanged.
6. On HCM success: set status=APPROVED, decrement `pendingBalance` and `hcmAvailableBalance` by `daysRequested`, store `hcmTransactionId`.

### PATCH /reject

1. Set status=REJECTED.
2. Decrement `pendingBalance` by `daysRequested` (reservation released, no HCM call).

### PATCH /cancel (PENDING)

1. Set status=CANCELLED.
2. Decrement `pendingBalance` by `daysRequested` (no HCM call).

### PATCH /cancel (APPROVED)

**Primary path (HCM cancel API available):**

1. Guard: if `hcmTransactionId` is null (should not happen in normal flow but possible if a partial failure occurred during approval), return 422 — do not call HCM.
2. Call HCM to cancel the transaction (`hcmTransactionId`). HCM reverses the deduction on its side.
2. If HCM errors → return 503, leave all local state unchanged (fail closed — request stays APPROVED, cache untouched).
3. On HCM success: set status=CANCELLED.
4. Immediately re-fetch `hcmAvailableBalance` from HCM's realtime API and overwrite the local cache. Because HCM has already restored the days, the fresh fetch reflects the correct restored balance without waiting for the next batch sync. ReadyOn does **not** manually add days back to the cache — it trusts HCM's response as the source of truth.

**Degraded path (HCM cancel API not available):**

1. Set status=CANCELLED in ReadyOn.
2. Do **not** touch `hcmAvailableBalance` in the local cache. Manually adjusting the cache would cause ReadyOn to show a balance higher than HCM knows about — the next batch sync would overwrite it back to the wrong value anyway.
3. The employee's balance remains incorrect in **both** systems (ReadyOn cache and HCM both still reflect the deduction) until HR manually reverses the entry inside HCM. Only after that reversal does the next batch sync bring ReadyOn's cache back in line.
4. Consequence: the employee cannot rebook the cancelled days until HR acts. This is a known product limitation of HCMs that do not expose a cancellation API.

### Scheduled batch sync (cron, every 6 hours)

1. Call HCM batch endpoint — receives full corpus of balances.
2. Upsert `hcmAvailableBalance` and `lastSyncedAt` for each record.
3. `pendingBalance` is never touched — it reflects ReadyOn's uncommitted holds, which HCM does not know about.
4. If new `hcmAvailableBalance` < current `pendingBalance`: no action. Existing PENDING requests will naturally fail the live HCM check on approval.
5. Log to `balance_sync_log` with source=BATCH_CRON. Other sources used elsewhere: REALTIME_PULL (logged on stale cache refresh during `GET /balance`), REQUEST (logged on live fetch during `POST /time-off/requests`).

---

## 7. Design Decisions

### 7.1 Balance reservation on PENDING (pessimistic)

**Decision:** Reserve days in `pendingBalance` at submission. HCM deduction happens only on approval.

**Why:** If reservation only happens on approval, two requests could both be submitted and approved before either reservation is recorded — over-committing the balance. Reserving on PENDING blocks the balance during the manager review window.

**Trade-off:** Days are tied up while a request awaits approval. Released on reject or cancel. Mirrors how real booking systems work (hold → confirm or release).

**Alternative rejected:** Reserve on APPROVE only. Creates a window for concurrent approvals to over-commit.

### 7.2 Optimistic locking on balance updates

**Decision:** `version` field on `time_off_balance`. Every update uses `WHERE version = :v` and increments the version. Zero rows updated = concurrent write won the race → 409, client retries.

**Why:** Two concurrent requests both read the same balance row, both pass the check, both try to deduct. The version field acts as a compare-and-swap: only the first writer succeeds; the second retries with fresh data and correctly fails the balance check.

**Alternative rejected:** Pessimistic row locking (`SELECT FOR UPDATE`). Serialises all balance reads, hurting throughput. Optimistic locking is better for low-contention workloads like time-off requests.

### 7.3 Idempotency key

**Decision:** `POST /time-off/requests` requires `Idempotency-Key: <uuid>` (client-generated). Duplicate key returns the original response.

**Why:** Optimistic locking prevents concurrent race conditions but not duplicate submissions from network retries. Without idempotency, a timeout + retry creates two requests and deducts balance twice.

**Note:** Idempotency key and optimistic lock solve different problems. Both are required.

### 7.4 Live HCM call on writes, cache on reads

**Decision:** Reads use local cache, refreshed only if `lastSyncedAt` > 15 minutes. Writes always call HCM's realtime API first.

**Why:** Reads can tolerate slight staleness. Writes cannot — a write based on stale data creates an invalid reservation or a rejected approval.

**Balance formula on writes:**
```
availableToReserve = hcmAvailableBalance (fresh from HCM) - pendingBalance (local holds)
```

Even with a fresh HCM balance, local pending holds must be subtracted — HCM does not know about them yet.

**Alternative rejected:** Pull from HCM on every read. Too expensive for high-frequency page loads and manager views.

### 7.5 Correctness over latency on the write path

**The tension:** The brief asks for "instant feedback" for employees, but also explicitly flags that HCM is not always reliable — it may silently succeed on an insufficient balance without returning an error. These two requirements pull in opposite directions.

**Decision:** Prioritise correctness over speed on the write path. Every write operation performs a defensive live `getBalance` check before committing, even if it adds latency.

**Why the defensive check cannot be removed:** If ReadyOn relied solely on HCM's `submitRequest` response to catch insufficient balance, a silent HCM failure would result in an approved request against a balance that doesn't exist. The pre-write `getBalance` is ReadyOn's own safety net — independent of HCM's error signalling — which the brief explicitly requires.

**The latency cost is real but bounded:**
- Submit: 1 live HCM call — typically 200–500ms for an enterprise HCM
- Approve: 2 live HCM calls (defensive check + commit) — typically 400ms–1s
- Each call retries up to 3 times on failure (500ms → 1s → 2s backoff) — worst case ~7.5s before 503

**Where "instant feedback" applies:** The brief's instant feedback expectation is best understood as applying to the **read path** — employees checking their balance see a cached response immediately without waiting for HCM. The write path inherently involves external coordination with HCM and cannot be made instantaneous without sacrificing the correctness guarantee the brief requires.

**Alternative considered:** Remove the pre-approve `getBalance` and rely on HCM's `submitRequest` error response as the sole gate. This reduces approve from 2 HCM calls to 1. Rejected because the brief explicitly states HCM errors are not guaranteed — a silent approval against insufficient balance is a worse outcome than slightly higher latency.

### 7.6 Pending list does not include live balance

**Decision:** `GET /time-off/requests/pending` returns raw request rows only — no balance information is attached.

**Why:** Enriching each pending request with a live HCM balance would require one HCM call per unique `employeeId + locationId` combination in the list. For a manager reviewing 50 requests across 20 employees, that is 20 sequential or parallel HCM calls just to render a list — expensive, slow, and fragile if HCM is degraded.

**Using cached balance is not a solution:** Returning `hcmAvailableBalance` from the local cache would be fast but defeats the purpose. If HCM changed the balance out-of-band (anniversary bonus, year-start reset, HR manual correction), the cache would show the old higher value and the manager would proceed to approve — only to get a 422 at approve time. The cache cannot be trusted for a decision that matters.

**The accepted tradeoff:** The pending list is intentionally a lightweight read. The manager gets an overview of what needs a decision, not a pre-validated approval surface. Correctness is enforced at approve time via a live HCM re-fetch — not at list time. The 422 with a descriptive error message (`"Insufficient balance: available=1, requested=9"`) is the safety net.

**In production:** The manager UI would call `GET /time-off/balance` for the specific employee when the manager opens an individual request detail view — one HCM call on demand, not N calls on list load. This keeps the list fast and the detail view accurate.

### 7.7 ReadyOn pulls from HCM (not HCM pushing)

**Decision:** ReadyOn runs a scheduled cron job (every 6 hours) calling HCM's batch endpoint.

**Why:** Enterprise HCMs (Workday, SAP) expose REST APIs for consumers to call. They do not push webhooks to downstream systems.

**Alternative rejected:** HCM pushes via webhooks. Assumes webhook capability most enterprise HCMs don't have, and adds inbound surface area and authentication complexity.

---

## 8. Failure Modes & Mitigations

| Failure | Behaviour |
|---|---|
| HCM unavailable on submission | Fail closed — 503 to employee, no local state changed |
| HCM unavailable on approval | Fail closed — 503 to manager, request stays PENDING |
| HCM silent success on bad balance | Local defensive check catches it before the HCM call |
| Concurrent duplicate submissions | Optimistic lock — second writer gets 409, retries with fresh data |
| Network retry creates duplicate request | Idempotency key — second call returns original response |
| HCM batch cron fails | Admin manual sync endpoint as escape hatch |
| Balance changes between submission and approval | Live HCM re-check on approval catches it |
| Batch sync returns lower balance than `pendingBalance` | `hcmAvailableBalance` updated; existing PENDING requests unaffected; approval fails naturally via live HCM check |
| HCM has no cancellation API for approved requests | ReadyOn marks request CANCELLED locally. Cache is **not** adjusted — manually adding days back would contradict HCM and be overwritten on the next batch sync. Balance remains wrong in both systems until HR manually reverses the entry in HCM; only then does the next batch sync restore the correct value. Employee cannot rebook the cancelled days until HR acts. |
| Overlapping date ranges | Rejected at submission with 422 |

---

## 9. Non-Goals & Assumptions

- **Auth/authorization:** Two layers are implemented:
  - **Role-based:** A `RolesGuard` reads the `X-User-Role` header (`employee`, `manager`, `admin`) forwarded by the upstream API gateway after JWT validation. The microservice trusts this header without re-verifying the token. Missing header → 401; wrong role → 403.
  - **User-level scoping:** The `X-User-Id` header (also gateway-forwarded) is checked against the resource being accessed. Employees can only view their own balance, submit requests for themselves, list their own requests, and cancel their own requests. Managers are not subject to this restriction — they act across all employees. Ownership is enforced in the controller for query-param checks and in the service for resource-level checks (e.g. cancel verifies `request.employeeId === userId` after fetching from DB).
  - In production both headers would be paired with network-level controls so the microservice is only reachable via the gateway, preventing header spoofing.
- **Calendar/business-day calculation:** Out of scope. The client supplies `daysRequested`. This varies by location, country, and holiday calendar — not derivable server-side without locale knowledge. The service stores `startDate`/`endDate` for overlap detection only.
- **leaveType:** Out of scope per the spec. A `leaveType` dimension (VACATION, SICK, PERSONAL) would be added in production to support separate leave buckets.
- **Audit trail:** `balance_sync_log` provides a full history of every balance change — when it happened, what triggered it (cron, manual, request), and what the before/after values were. What is not tracked is request status transition history (PENDING → APPROVED → CANCELLED). A `time_off_request_events` table would be recommended in production to record every status change with a timestamp and actor. Currently status transitions are only visible via `updatedAt` on the request row, which is overwritten on each change.
- **Rate limiting:** Not implemented. In production, the submit endpoint in particular should be rate-limited per employee (e.g. max 10 requests per minute) to prevent accidental or malicious flooding. This is typically handled at the API gateway layer rather than the microservice itself.
- **Database schema migrations:** TypeORM `synchronize: true` is used, which auto-creates and modifies tables on startup. This is safe for development and testing but must be replaced with explicit migration files in production — auto-sync can cause data loss if a column is renamed or removed.

---

## 10. Test Strategy

### Unit tests (`test/unit/`)

Service-layer logic with mocked dependencies. Covers: balance calculation, state machine transitions (all valid and invalid), HCM client retry logic and timeout handling.

### Integration tests (`test/integration/`)

Controller → Service → real SQLite (in-memory). Covers: full DB write paths, optimistic lock conflict resolution, batch sync reconciliation, pending balance release on reject.

### E2E tests (`test/e2e/`)

Full HTTP flow against a running NestJS app (port 3000) with the mock HCM server started programmatically inside the test process (port 3001). The mock HCM exposes test-control endpoints to simulate anniversary bonuses, year-start resets, and error injection — validating retry logic, timeouts, and fail-closed behavior over real HTTP.

**E2E scenarios covered:**

| # | Scenario |
|---|---|
| 0a | Missing X-User-Role header → 401 |
| 0b | Wrong role on manager endpoint → 403 |
| 0c | Employee cannot access manager pending list → 403 |
| 0d | Non-admin cannot trigger batch sync → 403 |
| 0e | Employee cannot view another employee's balance → 403 |
| 0f | Employee cannot submit request for another employee → 403 |
| 0g | Employee cannot cancel another employee's request → 403 |
| 1 | Happy path: submit → approve → balance reduced |
| 2 | Insufficient balance → 422 |
| 3 | HCM error on approve → request stays PENDING |
| 4 | HCM silent bad balance → local defensive check returns 422 |
| 5 | Concurrent requests → at most one succeeds |
| 6 | Anniversary bonus → batch sync → balance increases |
| 7 | Admin batch sync updates local balance |
| 8 | Cancel PENDING → pendingBalance released |
| 9 | GET balance fetches fresh from HCM when no local record |
| 10 | HCM down on submit → 503 |
| 11 | HCM down on approve → 503, request stays PENDING |
| 12 | Cancel APPROVED → HCM reversed → balance restored immediately (no sync wait) |
| 12b | Cancel APPROVED when HCM down → 503, request stays APPROVED (fail closed) |
| 13 | Reject → pendingBalance released → resubmit succeeds |
| 14 | Year-start reset → admin sync → balance updated |
| 15 | Same Idempotency-Key → same response, balance deducted once |
| 16 | Missing Idempotency-Key → 400 |
| 17a | Filter requests by status=PENDING → only PENDING returned |
| 17b | Filter requests by status=APPROVED → only APPROVED returned |
| 17c | No status filter → all statuses returned |
| 17d | Invalid ?status= value → 400 |
| 17e | Note exceeding 500 characters → 400 |
| 17 | Overlapping dates → 422 |

---

## 11. Configuration

| Env var | Default | Description |
|---|---|---|
| `HCM_BASE_URL` | `http://localhost:3001` | HCM server base URL |
| `HCM_TIMEOUT_MS` | `5000` | Per-request timeout to HCM |
| `HCM_RETRY_COUNT` | `3` | Max retries on HCM failure |
| `HCM_BATCH_CRON` | `0 */6 * * *` | Cron schedule for batch sync |
| `DATABASE_PATH` | `./data/timeoff.sqlite` | SQLite file path (`:memory:` in tests) |
| `BALANCE_STALENESS_THRESHOLD_MINUTES` | `15` | Max age of cached balance before a read triggers a live HCM fetch |
| `PORT` | `3000` | HTTP port |
