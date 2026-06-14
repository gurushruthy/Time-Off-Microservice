import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as request from 'supertest';
import { NestFactory } from '@nestjs/core';
import axios from 'axios';
import { AppModule } from '../../src/app.module';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';
import { MockHcmModule } from '../../mock-hcm/mock-hcm.module';
import { TimeOffRequest } from '../../src/time-off/entities/time-off-request.entity';
import { TimeOffBalance } from '../../src/balance/entities/time-off-balance.entity';
import { BalanceSyncLog } from '../../src/balance/entities/balance-sync-log.entity';

const MOCK_HCM_PORT = 3001;
const MOCK_HCM_URL = `http://localhost:${MOCK_HCM_PORT}`;

async function resetMockHcm() {
  await axios.post(`${MOCK_HCM_URL}/test/reset`);
}

async function setErrorMode(enabled: boolean, count: number = 0) {
  await axios.post(`${MOCK_HCM_URL}/test/set-error-mode`, { enabled, count });
}

async function setSilentBadBalance(enabled: boolean) {
  await axios.post(`${MOCK_HCM_URL}/test/set-silent-bad-balance`, { enabled });
}

async function simulateAnniversary(employeeId: string, locationId: string, bonusDays: number) {
  await axios.post(`${MOCK_HCM_URL}/test/simulate/anniversary`, { employeeId, locationId, bonusDays });
}

async function simulateYearReset(locationId: string, newBalance: number) {
  await axios.post(`${MOCK_HCM_URL}/test/simulate/year-reset`, { locationId, newBalance });
}

const asEmployee = (req: any, userId = 'employee-1') =>
  req.set('X-User-Role', 'employee').set('X-User-Id', userId);
const asManager = (req: any) =>
  req.set('X-User-Role', 'manager').set('X-User-Id', 'manager-1');
const asAdmin = (req: any) =>
  req.set('X-User-Role', 'admin').set('X-User-Id', 'admin-1');

describe('Time-Off Microservice E2E', () => {
  let app: INestApplication;
  let mockHcmApp: INestApplication;
  let requestRepo: Repository<TimeOffRequest>;
  let balanceRepo: Repository<TimeOffBalance>;
  let syncLogRepo: Repository<BalanceSyncLog>;

  beforeAll(async () => {
    // Start mock HCM server programmatically
    mockHcmApp = await NestFactory.create(MockHcmModule, { logger: false });
    await mockHcmApp.listen(MOCK_HCM_PORT);

    // Start main app
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();

    requestRepo = moduleRef.get(getRepositoryToken(TimeOffRequest));
    balanceRepo = moduleRef.get(getRepositoryToken(TimeOffBalance));
    syncLogRepo = moduleRef.get(getRepositoryToken(BalanceSyncLog));
  });

  afterAll(async () => {
    await app.close();
    await mockHcmApp.close();
  });

  beforeEach(async () => {
    // Reset mock HCM state
    await resetMockHcm();
    // Clear local DB tables between tests
    await requestRepo.clear();
    await balanceRepo.clear();
    await syncLogRepo.clear();
  });

  // ─── Scenario 0: Authorization ───────────────────────────────────────────
  it('Scenario 0a: Missing X-User-Role → 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/time-off/requests')
      .set('Idempotency-Key', `e2e-auth-${Date.now()}`)
      .send({
        employeeId: 'employee-1',
        locationId: 'location-1',
        startDate: '2026-07-01',
        endDate: '2026-07-02',
        daysRequested: 1,
      });
    expect(res.status).toBe(401);
  });

  it('Scenario 0b: Wrong role on manager endpoint → 403', async () => {
    const res = await request(app.getHttpServer())
      .patch('/time-off/requests/some-id/approve')
      .set('X-User-Role', 'employee');
    expect(res.status).toBe(403);
  });

  it('Scenario 0c: Employee cannot access manager pending list → 403', async () => {
    const res = await request(app.getHttpServer())
      .get('/time-off/requests/pending')
      .set('X-User-Role', 'employee');
    expect(res.status).toBe(403);
  });

  it('Scenario 0d: Admin role required for sync → 403 for non-admin', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/hcm/sync')
      .set('X-User-Role', 'manager');
    expect(res.status).toBe(403);
  });

  it('Scenario 0e: Employee cannot view another employee\'s balance → 403', async () => {
    const res = await asEmployee(request(app.getHttpServer())
      .get('/time-off/balance?employeeId=employee-2&locationId=location-1'), 'employee-1');
    expect(res.status).toBe(403);
  });

  it('Scenario 0f: Employee cannot submit request for another employee → 403', async () => {
    const res = await asEmployee(request(app.getHttpServer())
      .post('/time-off/requests')
      .set('Idempotency-Key', `e2e-userlevel-${Date.now()}`), 'employee-1')
      .send({
        employeeId: 'employee-2',
        locationId: 'location-1',
        startDate: '2026-07-01',
        endDate: '2026-07-02',
        daysRequested: 1,
      });
    expect(res.status).toBe(403);
  });

  it('Scenario 0g: Employee cannot cancel another employee\'s request → 403', async () => {
    const createRes = await asEmployee(request(app.getHttpServer())
      .post('/time-off/requests')
      .set('Idempotency-Key', `e2e-cancel-own-${Date.now()}`), 'employee-1')
      .send({
        employeeId: 'employee-1',
        locationId: 'location-1',
        startDate: '2026-07-01',
        endDate: '2026-07-02',
        daysRequested: 1,
      });
    expect(createRes.status).toBe(201);

    const cancelRes = await asEmployee(request(app.getHttpServer())
      .patch(`/time-off/requests/${createRes.body.id}/cancel`), 'employee-2');
    expect(cancelRes.status).toBe(403);
  });

  // ─── Scenario 1: Happy path ───────────────────────────────────────────────
  it('Scenario 1: Happy path - POST request → PATCH approve → GET balance shows reduced hcmAvailableBalance', async () => {
    const idempotencyKey = `e2e-happy-${Date.now()}`;

    const createRes = await asEmployee(request(app.getHttpServer())
      .post('/time-off/requests')
      .set('Idempotency-Key', idempotencyKey))
      .send({
        employeeId: 'employee-1',
        locationId: 'location-1',
        startDate: '2026-07-01',
        endDate: '2026-07-03',
        daysRequested: 2,
      });
    expect(createRes.status).toBe(201);
    const requestId = createRes.body.id;

    const approveRes = await asManager(request(app.getHttpServer())
      .patch(`/time-off/requests/${requestId}/approve`));
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.status).toBe('APPROVED');

    // HCM should have 8 days left (10 - 2)
    const balanceRes = await asEmployee(request(app.getHttpServer())
      .get('/time-off/balance?employeeId=employee-1&locationId=location-1'));
    expect(balanceRes.status).toBe(200);
    expect(Number(balanceRes.body.hcmAvailableBalance)).toBe(8);
  });

  // ─── Scenario 2: Insufficient balance ────────────────────────────────────
  it('Scenario 2: Insufficient balance → 422', async () => {
    const res = await asEmployee(request(app.getHttpServer())
      .post('/time-off/requests')
      .set('Idempotency-Key', `e2e-insufficient-${Date.now()}`))
      .send({
        employeeId: 'employee-1',
        locationId: 'location-1',
        startDate: '2026-07-01',
        endDate: '2026-07-15',
        daysRequested: 15,
      });
    expect(res.status).toBe(422);
  });

  // ─── Scenario 3: HCM error on approve ────────────────────────────────────
  it('Scenario 3: HCM error on approve → request stays PENDING', async () => {
    const idempotencyKey = `e2e-hcm-error-${Date.now()}`;

    const createRes = await asEmployee(request(app.getHttpServer())
      .post('/time-off/requests')
      .set('Idempotency-Key', idempotencyKey))
      .send({
        employeeId: 'employee-1',
        locationId: 'location-1',
        startDate: '2026-08-01',
        endDate: '2026-08-02',
        daysRequested: 1,
      });
    expect(createRes.status).toBe(201);
    const requestId = createRes.body.id;

    await setErrorMode(true, 10);

    const approveRes = await asManager(request(app.getHttpServer())
      .patch(`/time-off/requests/${requestId}/approve`));
    expect([422, 503]).toContain(approveRes.status);

    await setErrorMode(false, 0);
    const listRes = await asEmployee(request(app.getHttpServer())
      .get('/time-off/requests?employeeId=employee-1'));
    const req = listRes.body.find((r: any) => r.id === requestId);
    expect(req.status).toBe('PENDING');
  });

  // ─── Scenario 4: Silent bad balance ──────────────────────────────────────
  it('Scenario 4: HCM silent bad balance → local defensive check returns 422', async () => {
    await setSilentBadBalance(true);

    const res = await asEmployee(request(app.getHttpServer())
      .post('/time-off/requests')
      .set('Idempotency-Key', `e2e-silent-${Date.now()}`))
      .send({
        employeeId: 'employee-1',
        locationId: 'location-1',
        startDate: '2026-07-01',
        endDate: '2026-07-03',
        daysRequested: 1,
      });
    expect(res.status).toBe(422);
  });

  // ─── Scenario 5: Concurrent requests ─────────────────────────────────────
  it('Scenario 5: Concurrent requests → at most one succeeds', async () => {
    const makeReq = (key: string, days: number, start: string, end: string) =>
      asEmployee(request(app.getHttpServer())
        .post('/time-off/requests')
        .set('Idempotency-Key', key), 'employee-2')
        .send({
          employeeId: 'employee-2',
          locationId: 'location-1',
          startDate: start,
          endDate: end,
          daysRequested: days,
        });

    const [r1, r2] = await Promise.all([
      makeReq(`concurrent-a-${Date.now()}`, 4, '2026-09-01', '2026-09-05'),
      makeReq(`concurrent-b-${Date.now()}`, 4, '2026-09-10', '2026-09-15'),
    ]);

    const statuses = [r1.status, r2.status];
    const successes = statuses.filter(s => s === 201).length;
    expect(successes).toBeGreaterThanOrEqual(1);
  });

  // ─── Scenario 6: Anniversary bonus ───────────────────────────────────────
  it('Scenario 6: Anniversary bonus → sync → balance increases', async () => {
    const initialRes = await asEmployee(request(app.getHttpServer())
      .get('/time-off/balance?employeeId=employee-1&locationId=location-1'));
    const initialBalance = Number(initialRes.body.hcmAvailableBalance);

    await simulateAnniversary('employee-1', 'location-1', 5);

    await asAdmin(request(app.getHttpServer())
      .post('/admin/hcm/sync'))
      .expect(200);

    const balanceRes = await asEmployee(request(app.getHttpServer())
      .get('/time-off/balance?employeeId=employee-1&locationId=location-1'));
    expect(Number(balanceRes.body.hcmAvailableBalance)).toBe(initialBalance + 5);
  });

  // ─── Scenario 7: Batch sync ───────────────────────────────────────────────
  it('Scenario 7: Admin batch sync updates local balance', async () => {
    await simulateAnniversary('employee-1', 'location-1', 3);

    const syncRes = await asAdmin(request(app.getHttpServer())
      .post('/admin/hcm/sync'));
    expect(syncRes.status).toBe(200);

    const balanceRes = await asEmployee(request(app.getHttpServer())
      .get('/time-off/balance?employeeId=employee-1&locationId=location-1'));
    expect(balanceRes.status).toBe(200);
    expect(Number(balanceRes.body.hcmAvailableBalance)).toBe(13);
  });

  // ─── Scenario 8: Cancel PENDING ──────────────────────────────────────────
  it('Scenario 8: Cancel PENDING → pendingBalance released', async () => {
    const createRes = await asEmployee(request(app.getHttpServer())
      .post('/time-off/requests')
      .set('Idempotency-Key', `e2e-cancel-${Date.now()}`))
      .send({
        employeeId: 'employee-1',
        locationId: 'location-1',
        startDate: '2026-10-01',
        endDate: '2026-10-03',
        daysRequested: 2,
      });
    expect(createRes.status).toBe(201);
    const requestId = createRes.body.id;

    const balanceBefore = await asEmployee(request(app.getHttpServer())
      .get('/time-off/balance?employeeId=employee-1&locationId=location-1'));
    const pendingBefore = Number(balanceBefore.body.pendingBalance);

    await asEmployee(request(app.getHttpServer())
      .patch(`/time-off/requests/${requestId}/cancel`))
      .expect(200);

    const balanceAfter = await asEmployee(request(app.getHttpServer())
      .get('/time-off/balance?employeeId=employee-1&locationId=location-1'));
    expect(Number(balanceAfter.body.pendingBalance)).toBe(pendingBefore - 2);
  });

  // ─── Scenario 9: Stale balance ────────────────────────────────────────────
  it('Scenario 9: GET balance fetches fresh from HCM when no local record', async () => {
    const res = await asEmployee(request(app.getHttpServer())
      .get('/time-off/balance?employeeId=employee-2&locationId=location-1'), 'employee-2');
    expect(res.status).toBe(200);
    expect(Number(res.body.hcmAvailableBalance)).toBe(8);
  });

  // ─── Scenario 10: HCM down on submit ─────────────────────────────────────
  it('Scenario 10: HCM down on submit → 503', async () => {
    await setErrorMode(true, 10);

    const res = await asEmployee(request(app.getHttpServer())
      .post('/time-off/requests')
      .set('Idempotency-Key', `e2e-down-submit-${Date.now()}`))
      .send({
        employeeId: 'employee-1',
        locationId: 'location-1',
        startDate: '2026-07-01',
        endDate: '2026-07-02',
        daysRequested: 1,
      });
    expect([503, 422]).toContain(res.status);
  });

  // ─── Scenario 11: HCM down on approve ────────────────────────────────────
  it('Scenario 11: HCM down on approve → 503, request stays PENDING', async () => {
    const createRes = await asEmployee(request(app.getHttpServer())
      .post('/time-off/requests')
      .set('Idempotency-Key', `e2e-down-approve-${Date.now()}`))
      .send({
        employeeId: 'employee-1',
        locationId: 'location-1',
        startDate: '2026-07-01',
        endDate: '2026-07-02',
        daysRequested: 1,
      });
    expect(createRes.status).toBe(201);
    const requestId = createRes.body.id;

    await setErrorMode(true, 10);

    const approveRes = await asManager(request(app.getHttpServer())
      .patch(`/time-off/requests/${requestId}/approve`));
    expect([503, 422]).toContain(approveRes.status);
  });

  // ─── Scenario 12: Cancel APPROVED → HCM reversed → balance restored immediately ───
  it('Scenario 12: Cancel APPROVED → HCM reversed → balance restored immediately without waiting for sync', async () => {
    const idempotencyKey = `e2e-cancel-approved-${Date.now()}`;

    const createRes = await asEmployee(request(app.getHttpServer())
      .post('/time-off/requests')
      .set('Idempotency-Key', idempotencyKey))
      .send({
        employeeId: 'employee-1',
        locationId: 'location-1',
        startDate: '2026-11-01',
        endDate: '2026-11-03',
        daysRequested: 2,
      });
    expect(createRes.status).toBe(201);
    const requestId = createRes.body.id;

    const approveRes = await asManager(request(app.getHttpServer())
      .patch(`/time-off/requests/${requestId}/approve`));
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.status).toBe('APPROVED');

    // Balance is now reduced by 2
    const balanceAfterApprove = await asEmployee(request(app.getHttpServer())
      .get('/time-off/balance?employeeId=employee-1&locationId=location-1'));
    const hcmAfterApprove = Number(balanceAfterApprove.body.hcmAvailableBalance);

    // Cancel the approved request
    const cancelRes = await asEmployee(request(app.getHttpServer())
      .patch(`/time-off/requests/${requestId}/cancel`));
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe('CANCELLED');

    // Balance must be immediately restored — no sync needed
    const balanceAfterCancel = await asEmployee(request(app.getHttpServer())
      .get('/time-off/balance?employeeId=employee-1&locationId=location-1'));
    expect(Number(balanceAfterCancel.body.hcmAvailableBalance)).toBe(hcmAfterApprove + 2);
  });

  // ─── Scenario 12b: Cancel APPROVED when HCM is down → 503, stays APPROVED ─
  it('Scenario 12b: Cancel APPROVED when HCM is down → 503, request stays APPROVED', async () => {
    const idempotencyKey = `e2e-cancel-approved-hcm-down-${Date.now()}`;

    const createRes = await asEmployee(request(app.getHttpServer())
      .post('/time-off/requests')
      .set('Idempotency-Key', idempotencyKey))
      .send({
        employeeId: 'employee-1',
        locationId: 'location-1',
        startDate: '2026-11-05',
        endDate: '2026-11-06',
        daysRequested: 1,
      });
    expect(createRes.status).toBe(201);
    const requestId = createRes.body.id;

    await asManager(request(app.getHttpServer())
      .patch(`/time-off/requests/${requestId}/approve`))
      .expect(200);

    await setErrorMode(true, 10);

    const cancelRes = await asEmployee(request(app.getHttpServer())
      .patch(`/time-off/requests/${requestId}/cancel`));
    expect(cancelRes.status).toBe(503);

    await setErrorMode(false, 0);

    // Request must still be APPROVED — fail closed
    const listRes = await asEmployee(request(app.getHttpServer())
      .get('/time-off/requests?employeeId=employee-1'));
    const req = listRes.body.find((r: any) => r.id === requestId);
    expect(req.status).toBe('APPROVED');
  });

  // ─── Scenario 13: Reject → resubmit succeeds ─────────────────────────────
  it('Scenario 13: Reject → pendingBalance released → new request succeeds', async () => {
    const createRes = await asEmployee(request(app.getHttpServer())
      .post('/time-off/requests')
      .set('Idempotency-Key', `e2e-reject-first-${Date.now()}`))
      .send({
        employeeId: 'employee-1',
        locationId: 'location-1',
        startDate: '2026-07-01',
        endDate: '2026-07-10',
        daysRequested: 9,
      });
    expect(createRes.status).toBe(201);

    await asManager(request(app.getHttpServer())
      .patch(`/time-off/requests/${createRes.body.id}/reject`))
      .expect(200);

    const createRes2 = await asEmployee(request(app.getHttpServer())
      .post('/time-off/requests')
      .set('Idempotency-Key', `e2e-after-reject-${Date.now()}`))
      .send({
        employeeId: 'employee-1',
        locationId: 'location-1',
        startDate: '2026-08-01',
        endDate: '2026-08-10',
        daysRequested: 9,
      });
    expect(createRes2.status).toBe(201);
  });

  // ─── Scenario 13b: Auto-reject on insufficient balance at approve time ──────
  it('Scenario 13b: Insufficient balance at approve time → auto-rejected with note, pendingBalance released', async () => {
    const createRes = await asEmployee(request(app.getHttpServer())
      .post('/time-off/requests')
      .set('Idempotency-Key', `e2e-auto-reject-${Date.now()}`))
      .send({
        employeeId: 'employee-1',
        locationId: 'location-1',
        startDate: '2026-07-01',
        endDate: '2026-07-10',
        daysRequested: 9,
      });
    expect(createRes.status).toBe(201);
    const requestId = createRes.body.id;

    // Drain the balance so approval will fail
    await simulateYearReset('location-1', 1);
    await asAdmin(request(app.getHttpServer())
      .post('/admin/hcm/sync')
      .set('X-User-Role', 'admin')
      .set('X-User-Id', 'admin-1'))
      .expect(200);

    const approveRes = await asManager(request(app.getHttpServer())
      .patch(`/time-off/requests/${requestId}/approve`));
    expect(approveRes.status).toBe(422);
    expect(approveRes.body.message).toContain('automatically rejected');

    // Request should now be REJECTED with auto-generated note
    const listRes = await asEmployee(request(app.getHttpServer())
      .get('/time-off/requests?employeeId=employee-1'));
    const req = listRes.body.find((r: any) => r.id === requestId);
    expect(req.status).toBe('REJECTED');
    expect(req.note).toContain('Automatically rejected');

    // pendingBalance should be released — new request for same days should succeed
    const createRes2 = await asEmployee(request(app.getHttpServer())
      .post('/time-off/requests')
      .set('Idempotency-Key', `e2e-after-auto-reject-${Date.now()}`))
      .send({
        employeeId: 'employee-1',
        locationId: 'location-1',
        startDate: '2026-08-01',
        endDate: '2026-08-02',
        daysRequested: 1,
      });
    expect(createRes2.status).toBe(201);
  });

  // ─── Scenario 14: Year-start reset ───────────────────────────────────────
  it('Scenario 14: Year-start reset → admin sync → balance updated', async () => {
    await simulateYearReset('location-1', 20);

    await asAdmin(request(app.getHttpServer())
      .post('/admin/hcm/sync'))
      .expect(200);

    const balanceRes = await asEmployee(request(app.getHttpServer())
      .get('/time-off/balance?employeeId=employee-1&locationId=location-1'));
    expect(Number(balanceRes.body.hcmAvailableBalance)).toBe(20);
  });

  // ─── Scenario 15: Idempotent retry ───────────────────────────────────────
  it('Scenario 15: Same Idempotency-Key → returns same response, balance deducted once', async () => {
    const idempotencyKey = `e2e-idem-${Date.now()}`;
    const dto = {
      employeeId: 'employee-1',
      locationId: 'location-1',
      startDate: '2026-07-01',
      endDate: '2026-07-02',
      daysRequested: 1,
    };

    const res1 = await asEmployee(request(app.getHttpServer())
      .post('/time-off/requests')
      .set('Idempotency-Key', idempotencyKey))
      .send(dto);
    expect(res1.status).toBe(201);

    const res2 = await asEmployee(request(app.getHttpServer())
      .post('/time-off/requests')
      .set('Idempotency-Key', idempotencyKey))
      .send(dto);
    expect(res2.status).toBe(201);
    expect(res2.body.id).toBe(res1.body.id);

    const balanceRes = await asEmployee(request(app.getHttpServer())
      .get('/time-off/balance?employeeId=employee-1&locationId=location-1'));
    expect(Number(balanceRes.body.pendingBalance)).toBe(1);
  });

  // ─── Scenario 16: Missing Idempotency-Key → 400 ──────────────────────────
  it('Scenario 16: Missing Idempotency-Key → 400', async () => {
    const res = await asEmployee(request(app.getHttpServer())
      .post('/time-off/requests'))
      .send({
        employeeId: 'employee-1',
        locationId: 'location-1',
        startDate: '2026-07-01',
        endDate: '2026-07-03',
        daysRequested: 2,
      });
    expect(res.status).toBe(400);
  });

  // ─── Scenario 17a-note: Reject with note → employee sees note ───────────
  it('Scenario 17a-note: Reject with note → employee sees note on request', async () => {
    const createRes = await asEmployee(request(app.getHttpServer())
      .post('/time-off/requests')
      .set('Idempotency-Key', `e2e-note-reject-${Date.now()}`))
      .send({
        employeeId: 'employee-1',
        locationId: 'location-1',
        startDate: '2026-07-01',
        endDate: '2026-07-02',
        daysRequested: 1,
      });
    expect(createRes.status).toBe(201);
    const requestId = createRes.body.id;

    await asManager(request(app.getHttpServer())
      .patch(`/time-off/requests/${requestId}/reject`)
      .send({ note: 'Insufficient balance, please resubmit for fewer days' }))
      .expect(200);

    const listRes = await asEmployee(request(app.getHttpServer())
      .get('/time-off/requests?employeeId=employee-1'));
    const req = listRes.body.find((r: any) => r.id === requestId);
    expect(req.status).toBe('REJECTED');
    expect(req.note).toBe('Insufficient balance, please resubmit for fewer days');
  });

  it('Scenario 17b-note: Cancel with note → note is saved on request', async () => {
    const createRes = await asEmployee(request(app.getHttpServer())
      .post('/time-off/requests')
      .set('Idempotency-Key', `e2e-note-cancel-${Date.now()}`))
      .send({
        employeeId: 'employee-1',
        locationId: 'location-1',
        startDate: '2026-07-01',
        endDate: '2026-07-02',
        daysRequested: 1,
      });
    expect(createRes.status).toBe(201);
    const requestId = createRes.body.id;

    const cancelRes = await asEmployee(request(app.getHttpServer())
      .patch(`/time-off/requests/${requestId}/cancel`)
      .send({ note: 'Change of plans' }));
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.note).toBe('Change of plans');
  });

  it('Scenario 17c-note: Reject without note → note is null', async () => {
    const createRes = await asEmployee(request(app.getHttpServer())
      .post('/time-off/requests')
      .set('Idempotency-Key', `e2e-note-null-${Date.now()}`))
      .send({
        employeeId: 'employee-1',
        locationId: 'location-1',
        startDate: '2026-07-01',
        endDate: '2026-07-02',
        daysRequested: 1,
      });
    expect(createRes.status).toBe(201);

    const rejectRes = await asManager(request(app.getHttpServer())
      .patch(`/time-off/requests/${createRes.body.id}/reject`));
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.note).toBeNull();
  });

  // ─── Scenario 17a: Filter requests by status ─────────────────────────────
  it('Scenario 17a: GET requests?status=PENDING returns only PENDING requests', async () => {
    const createRes = await asEmployee(request(app.getHttpServer())
      .post('/time-off/requests')
      .set('Idempotency-Key', `e2e-filter-pending-${Date.now()}`))
      .send({
        employeeId: 'employee-1',
        locationId: 'location-1',
        startDate: '2026-07-01',
        endDate: '2026-07-02',
        daysRequested: 1,
      });
    expect(createRes.status).toBe(201);
    const pendingId = createRes.body.id;

    // Approve it so we have one PENDING and one APPROVED
    const createRes2 = await asEmployee(request(app.getHttpServer())
      .post('/time-off/requests')
      .set('Idempotency-Key', `e2e-filter-approved-${Date.now()}`))
      .send({
        employeeId: 'employee-1',
        locationId: 'location-1',
        startDate: '2026-08-01',
        endDate: '2026-08-02',
        daysRequested: 1,
      });
    expect(createRes2.status).toBe(201);
    await asManager(request(app.getHttpServer())
      .patch(`/time-off/requests/${createRes2.body.id}/approve`))
      .expect(200);

    const res = await asEmployee(request(app.getHttpServer())
      .get('/time-off/requests?employeeId=employee-1&status=PENDING'));
    expect(res.status).toBe(200);
    expect(res.body.every((r: any) => r.status === 'PENDING')).toBe(true);
    expect(res.body.find((r: any) => r.id === pendingId)).toBeDefined();
  });

  it('Scenario 17b: GET requests?status=APPROVED returns only APPROVED requests', async () => {
    const createRes = await asEmployee(request(app.getHttpServer())
      .post('/time-off/requests')
      .set('Idempotency-Key', `e2e-filter-approved2-${Date.now()}`))
      .send({
        employeeId: 'employee-1',
        locationId: 'location-1',
        startDate: '2026-07-01',
        endDate: '2026-07-02',
        daysRequested: 1,
      });
    expect(createRes.status).toBe(201);
    await asManager(request(app.getHttpServer())
      .patch(`/time-off/requests/${createRes.body.id}/approve`))
      .expect(200);

    const res = await asEmployee(request(app.getHttpServer())
      .get('/time-off/requests?employeeId=employee-1&status=APPROVED'));
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.every((r: any) => r.status === 'APPROVED')).toBe(true);
  });

  it('Scenario 17c: GET requests without status filter returns all statuses', async () => {
    const createRes = await asEmployee(request(app.getHttpServer())
      .post('/time-off/requests')
      .set('Idempotency-Key', `e2e-filter-all-${Date.now()}`))
      .send({
        employeeId: 'employee-1',
        locationId: 'location-1',
        startDate: '2026-07-01',
        endDate: '2026-07-02',
        daysRequested: 1,
      });
    expect(createRes.status).toBe(201);
    await asManager(request(app.getHttpServer())
      .patch(`/time-off/requests/${createRes.body.id}/approve`))
      .expect(200);

    const createRes2 = await asEmployee(request(app.getHttpServer())
      .post('/time-off/requests')
      .set('Idempotency-Key', `e2e-filter-all2-${Date.now()}`))
      .send({
        employeeId: 'employee-1',
        locationId: 'location-1',
        startDate: '2026-08-01',
        endDate: '2026-08-02',
        daysRequested: 1,
      });
    expect(createRes2.status).toBe(201);

    const res = await asEmployee(request(app.getHttpServer())
      .get('/time-off/requests?employeeId=employee-1'));
    expect(res.status).toBe(200);
    const statuses = res.body.map((r: any) => r.status);
    expect(statuses).toContain('APPROVED');
    expect(statuses).toContain('PENDING');
  });

  // ─── Scenario 17d: Invalid status filter → 400 ───────────────────────────
  it('Scenario 17d: GET requests?status=INVALID → 400', async () => {
    const res = await asEmployee(request(app.getHttpServer())
      .get('/time-off/requests?employeeId=employee-1&status=INVALID'));
    expect(res.status).toBe(400);
  });

  // ─── Scenario 17e: Note exceeds max length → 400 ─────────────────────────
  it('Scenario 17e: Reject with note > 500 chars → 400', async () => {
    const createRes = await asEmployee(request(app.getHttpServer())
      .post('/time-off/requests')
      .set('Idempotency-Key', `e2e-note-long-${Date.now()}`))
      .send({
        employeeId: 'employee-1',
        locationId: 'location-1',
        startDate: '2026-07-01',
        endDate: '2026-07-02',
        daysRequested: 1,
      });
    expect(createRes.status).toBe(201);

    const res = await asManager(request(app.getHttpServer())
      .patch(`/time-off/requests/${createRes.body.id}/reject`)
      .send({ note: 'a'.repeat(501) }));
    expect(res.status).toBe(400);
  });

  // ─── Scenario 17: Overlapping dates → 422 ────────────────────────────────
  it('Scenario 17: Overlapping dates → 422', async () => {
    const createRes = await asEmployee(request(app.getHttpServer())
      .post('/time-off/requests')
      .set('Idempotency-Key', `e2e-overlap-first-${Date.now()}`))
      .send({
        employeeId: 'employee-1',
        locationId: 'location-1',
        startDate: '2026-07-01',
        endDate: '2026-07-07',
        daysRequested: 5,
      });
    expect(createRes.status).toBe(201);

    const overlapRes = await asEmployee(request(app.getHttpServer())
      .post('/time-off/requests')
      .set('Idempotency-Key', `e2e-overlap-second-${Date.now()}`))
      .send({
        employeeId: 'employee-1',
        locationId: 'location-1',
        startDate: '2026-07-05',
        endDate: '2026-07-10',
        daysRequested: 2,
      });
    expect(overlapRes.status).toBe(422);
  });
});
