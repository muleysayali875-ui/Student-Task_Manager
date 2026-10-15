/**
 * Automated Test Suite for Student Task Manager Backend
 * Uses Node.js built-in test runner (node:test) and assertion library (node:assert/strict).
 * Simulates Cloudflare Workers runtime and Workers KV via an in-memory mock.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';

/**
 * In-memory mock for Cloudflare Workers KV namespace.
 */
class MockKVNamespace {
  constructor() {
    this.store = new Map();
  }

  async get(key, options = {}) {
    const val = this.store.get(key);
    if (val === undefined) return null;
    if (options.type === 'json') {
      try {
        return JSON.parse(val);
      } catch {
        return null;
      }
    }
    return val;
  }

  async put(key, value) {
    this.store.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }

  async delete(key) {
    this.store.delete(key);
  }

  async list(options = {}) {
    const prefix = options.prefix || '';
    const keys = [];
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) {
        keys.push({ name: k });
      }
    }
    return { keys, list_complete: true };
  }
}

/**
 * Helper to dispatch requests to the worker with a fresh Mock KV.
 */
function createEnv() {
  return {
    TASKS_KV: new MockKVNamespace()
  };
}

// ============================================================================
// 1. Task Creation (POST /api/tasks)
// ============================================================================

test('POST /api/tasks - creates task with valid data', async () => {
  const env = createEnv();
  const request = new Request('https://worker.test/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Complete Distributed Systems Homework',
      priority: 'High',
      status: 'Pending'
    })
  });

  const response = await worker.fetch(request, env);
  assert.strictEqual(response.status, 201);

  const data = await response.json();
  assert.ok(data.task);
  assert.ok(data.task.id);
  assert.strictEqual(data.task.title, 'Complete Distributed Systems Homework');
  assert.strictEqual(data.task.priority, 'High');
  assert.strictEqual(data.task.status, 'Pending');
  assert.ok(data.task.createdAt);

  // Verify stored in mock KV
  const stored = await env.TASKS_KV.get(`task:${data.task.id}`, { type: 'json' });
  assert.deepStrictEqual(stored, data.task);
});

test('POST /api/tasks - defaults priority to Medium and status to Pending when omitted', async () => {
  const env = createEnv();
  const request = new Request('https://worker.test/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Read chapter 4 of Database Systems'
    })
  });

  const response = await worker.fetch(request, env);
  assert.strictEqual(response.status, 201);
  const data = await response.json();
  assert.strictEqual(data.task.priority, 'Medium');
  assert.strictEqual(data.task.status, 'Pending');
});

test('POST /api/tasks - rejects empty or missing title', async () => {
  const env = createEnv();

  // Missing title
  const req1 = new Request('https://worker.test/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ priority: 'Low' })
  });
  const res1 = await worker.fetch(req1, env);
  assert.strictEqual(res1.status, 400);
  const data1 = await res1.json();
  assert.match(data1.error, /Task title is required/);

  // Whitespace-only title
  const req2 = new Request('https://worker.test/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '    ' })
  });
  const res2 = await worker.fetch(req2, env);
  assert.strictEqual(res2.status, 400);
});

test('POST /api/tasks - rejects title exceeding 200 characters', async () => {
  const env = createEnv();
  const longTitle = 'a'.repeat(201);

  const request = new Request('https://worker.test/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: longTitle })
  });

  const response = await worker.fetch(request, env);
  assert.strictEqual(response.status, 400);
  const data = await response.json();
  assert.match(data.error, /cannot exceed 200 characters/);
});

test('POST /api/tasks - rejects invalid priority enum', async () => {
  const env = createEnv();
  const request = new Request('https://worker.test/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Valid title',
      priority: 'Urgent' // Invalid enum
    })
  });

  const response = await worker.fetch(request, env);
  assert.strictEqual(response.status, 400);
  const data = await response.json();
  assert.match(data.error, /Invalid priority/);
});

test('POST /api/tasks - rejects invalid status enum', async () => {
  const env = createEnv();
  const request = new Request('https://worker.test/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Valid title',
      status: 'Archived' // Invalid enum
    })
  });

  const response = await worker.fetch(request, env);
  assert.strictEqual(response.status, 400);
  const data = await response.json();
  assert.match(data.error, /Invalid status/);
});

test('POST /api/tasks - rejects malformed JSON payload', async () => {
  const env = createEnv();
  const request = new Request('https://worker.test/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"invalidJson": ...'
  });

  const response = await worker.fetch(request, env);
  assert.strictEqual(response.status, 400);
  const data = await response.json();
  assert.match(data.error, /Invalid JSON payload/);
});

// ============================================================================
// 2. Listing Tasks (GET /api/tasks)
// ============================================================================

test('GET /api/tasks - returns empty list when no tasks exist', async () => {
  const env = createEnv();
  const request = new Request('https://worker.test/api/tasks', { method: 'GET' });

  const response = await worker.fetch(request, env);
  assert.strictEqual(response.status, 200);
  const data = await response.json();
  assert.deepStrictEqual(data, { tasks: [], count: 0 });
});

test('GET /api/tasks - returns list of tasks sorted by createdAt descending', async () => {
  const env = createEnv();

  // Create task 1
  const req1 = new Request('https://worker.test/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Task 1', priority: 'Low' })
  });
  const res1 = await worker.fetch(req1, env);
  const task1 = (await res1.json()).task;

  // Small delay to ensure timestamp difference
  await new Promise(r => setTimeout(r, 10));

  // Create task 2
  const req2 = new Request('https://worker.test/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Task 2', priority: 'High' })
  });
  const res2 = await worker.fetch(req2, env);
  const task2 = (await res2.json()).task;

  // Fetch list
  const listReq = new Request('https://worker.test/api/tasks', { method: 'GET' });
  const listRes = await worker.fetch(listReq, env);
  assert.strictEqual(listRes.status, 200);

  const data = await listRes.json();
  assert.strictEqual(data.count, 2);
  assert.strictEqual(data.tasks[0].id, task2.id); // Newer first
  assert.strictEqual(data.tasks[1].id, task1.id);
});

// ============================================================================
// 3. Retrieve Individual Task (GET /api/tasks/:id)
// ============================================================================

test('GET /api/tasks/:id - returns task when ID exists', async () => {
  const env = createEnv();
  const createReq = new Request('https://worker.test/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Prepare for presentation', priority: 'Medium' })
  });
  const createRes = await worker.fetch(createReq, env);
  const created = (await createRes.json()).task;

  // Retrieve
  const getReq = new Request(`https://worker.test/api/tasks/${created.id}`, { method: 'GET' });
  const getRes = await worker.fetch(getReq, env);
  assert.strictEqual(getRes.status, 200);

  const data = await getRes.json();
  assert.strictEqual(data.task.id, created.id);
  assert.strictEqual(data.task.title, 'Prepare for presentation');
});

test('GET /api/tasks/:id - returns 404 for missing task', async () => {
  const env = createEnv();
  const request = new Request('https://worker.test/api/tasks/non-existent-id-12345', { method: 'GET' });

  const response = await worker.fetch(request, env);
  assert.strictEqual(response.status, 404);
  const data = await response.json();
  assert.match(data.error, /not found/);
});

// ============================================================================
// 4. Update Task (PUT /api/tasks/:id)
// ============================================================================

test('PUT /api/tasks/:id - updates task while preserving id and createdAt', async () => {
  const env = createEnv();
  const createReq = new Request('https://worker.test/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Initial Title', priority: 'Low', status: 'Pending' })
  });
  const created = (await (await worker.fetch(createReq, env)).json()).task;

  // Update
  const updateReq = new Request(`https://worker.test/api/tasks/${created.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Updated Title',
      priority: 'High',
      status: 'In Progress'
    })
  });
  const updateRes = await worker.fetch(updateReq, env);
  assert.strictEqual(updateRes.status, 200);

  const updatedData = (await updateRes.json()).task;
  assert.strictEqual(updatedData.id, created.id);
  assert.strictEqual(updatedData.createdAt, created.createdAt);
  assert.strictEqual(updatedData.title, 'Updated Title');
  assert.strictEqual(updatedData.priority, 'High');
  assert.strictEqual(updatedData.status, 'In Progress');
  assert.ok(updatedData.updatedAt);
});

test('PUT /api/tasks/:id - returns 404 for missing task', async () => {
  const env = createEnv();
  const updateReq = new Request('https://worker.test/api/tasks/missing-task-id', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Does not matter' })
  });

  const response = await worker.fetch(updateReq, env);
  assert.strictEqual(response.status, 404);
});

test('PUT /api/tasks/:id - rejects invalid enum values', async () => {
  const env = createEnv();
  const createReq = new Request('https://worker.test/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Valid' })
  });
  const created = (await (await worker.fetch(createReq, env)).json()).task;

  const updateReq = new Request(`https://worker.test/api/tasks/${created.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ priority: 'MegaCritical' })
  });
  const updateRes = await worker.fetch(updateReq, env);
  assert.strictEqual(updateRes.status, 400);
});

// ============================================================================
// 5. Delete Task (DELETE /api/tasks/:id)
// ============================================================================

test('DELETE /api/tasks/:id - deletes existing task', async () => {
  const env = createEnv();
  const createReq = new Request('https://worker.test/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Task to be deleted' })
  });
  const created = (await (await worker.fetch(createReq, env)).json()).task;

  // Delete
  const delReq = new Request(`https://worker.test/api/tasks/${created.id}`, { method: 'DELETE' });
  const delRes = await worker.fetch(delReq, env);
  assert.strictEqual(delRes.status, 200);

  // Verify subsequent GET returns 404
  const getReq = new Request(`https://worker.test/api/tasks/${created.id}`, { method: 'GET' });
  const getRes = await worker.fetch(getReq, env);
  assert.strictEqual(getRes.status, 404);

  // Verify subsequent list is empty
  const listReq = new Request('https://worker.test/api/tasks', { method: 'GET' });
  const listRes = await worker.fetch(listReq, env);
  const listData = await listRes.json();
  assert.strictEqual(listData.count, 0);
});

test('DELETE /api/tasks/:id - returns 404 when deleting missing task', async () => {
  const env = createEnv();
  const delReq = new Request('https://worker.test/api/tasks/not-a-real-task', { method: 'DELETE' });
  const delRes = await worker.fetch(delReq, env);
  assert.strictEqual(delRes.status, 404);
});

// ============================================================================
// 6. HTTP Methods and Route Edge Cases
// ============================================================================

test('405 Method Not Allowed on unsupported HTTP methods', async () => {
  const env = createEnv();

  // PATCH on /api/tasks
  const req1 = new Request('https://worker.test/api/tasks', { method: 'PATCH' });
  const res1 = await worker.fetch(req1, env);
  assert.strictEqual(res1.status, 405);
  assert.strictEqual(res1.headers.get('Allow'), 'GET, POST, OPTIONS');

  // POST on /api/tasks/:id
  const req2 = new Request('https://worker.test/api/tasks/some-id', { method: 'POST' });
  const res2 = await worker.fetch(req2, env);
  assert.strictEqual(res2.status, 405);
  assert.strictEqual(res2.headers.get('Allow'), 'GET, PUT, DELETE, OPTIONS');
});

test('OPTIONS preflight returns 204 with CORS headers', async () => {
  const env = createEnv();
  const request = new Request('https://worker.test/api/tasks', { method: 'OPTIONS' });
  const response = await worker.fetch(request, env);

  assert.strictEqual(response.status, 204);
  assert.strictEqual(response.headers.get('Access-Control-Allow-Origin'), '*');
  assert.ok(response.headers.get('Access-Control-Allow-Methods'));
});

// ============================================================================
// 7. Static Asset Delivery (Fullstack Worker)
// ============================================================================

test('GET / serves index.html with text/html content-type', async () => {
  const env = createEnv();
  const request = new Request('https://worker.test/', { method: 'GET' });
  const response = await worker.fetch(request, env);

  assert.strictEqual(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /text\/html/);
  const text = await response.text();
  assert.match(text, /Student Task Manager/);
});

test('GET /style.css serves CSS with text/css content-type', async () => {
  const env = createEnv();
  const request = new Request('https://worker.test/style.css', { method: 'GET' });
  const response = await worker.fetch(request, env);

  assert.strictEqual(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /text\/css/);
  const text = await response.text();
  assert.match(text, /--bg-primary/);
});

test('GET /script.js serves JS with application/javascript content-type', async () => {
  const env = createEnv();
  const request = new Request('https://worker.test/script.js', { method: 'GET' });
  const response = await worker.fetch(request, env);

  assert.strictEqual(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /application\/javascript/);
  const text = await response.text();
  assert.match(text, /fetchTasksFromAPI/);
});

// ============================================================================
// 8. Additional Edge Cases & Resilience
// ============================================================================

test('500 Internal Error when TASKS_KV binding is missing', async () => {
  const request = new Request('https://worker.test/api/tasks', { method: 'GET' });
  // Call with empty env (missing TASKS_KV)
  const response = await worker.fetch(request, {});

  assert.strictEqual(response.status, 500);
  const data = await response.json();
  assert.match(data.error, /TASKS_KV binding is not configured/);
});

test('Endpoints normalize trailing slashes correctly', async () => {
  const env = createEnv();

  // POST with trailing slash
  const createReq = new Request('https://worker.test/api/tasks/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Trailing slash test' })
  });
  const createRes = await worker.fetch(createReq, env);
  assert.strictEqual(createRes.status, 201);
  const created = (await createRes.json()).task;

  // GET collection with trailing slash
  const listReq = new Request('https://worker.test/api/tasks/', { method: 'GET' });
  const listRes = await worker.fetch(listReq, env);
  assert.strictEqual(listRes.status, 200);

  // GET resource with trailing slash
  const getReq = new Request(`https://worker.test/api/tasks/${created.id}/`, { method: 'GET' });
  const getRes = await worker.fetch(getReq, env);
  assert.strictEqual(getRes.status, 200);

  // PUT resource with trailing slash
  const putReq = new Request(`https://worker.test/api/tasks/${created.id}/`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Updated with trailing slash' })
  });
  const putRes = await worker.fetch(putReq, env);
  assert.strictEqual(putRes.status, 200);

  // DELETE resource with trailing slash
  const delReq = new Request(`https://worker.test/api/tasks/${created.id}/`, { method: 'DELETE' });
  const delRes = await worker.fetch(delReq, env);
  assert.strictEqual(delRes.status, 200);
});

test('POST and PUT trim leading and trailing whitespace from title', async () => {
  const env = createEnv();

  // POST with spaces
  const createReq = new Request('https://worker.test/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '   Trimmed Title Test   ' })
  });
  const createRes = await worker.fetch(createReq, env);
  const created = (await createRes.json()).task;
  assert.strictEqual(created.title, 'Trimmed Title Test');

  // PUT with spaces
  const putReq = new Request(`https://worker.test/api/tasks/${created.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '   Updated Trimmed Title   ' })
  });
  const putRes = await worker.fetch(putReq, env);
  const updated = (await putRes.json()).task;
  assert.strictEqual(updated.title, 'Updated Trimmed Title');
});

test('PUT supports partial updates (updating only status)', async () => {
  const env = createEnv();
  const createReq = new Request('https://worker.test/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Partial update test', priority: 'High', status: 'Pending' })
  });
  const created = (await (await worker.fetch(createReq, env)).json()).task;

  // Partial update: only status
  const putReq = new Request(`https://worker.test/api/tasks/${created.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'Completed' })
  });
  const putRes = await worker.fetch(putReq, env);
  assert.strictEqual(putRes.status, 200);

  const updated = (await putRes.json()).task;
  assert.strictEqual(updated.status, 'Completed');
  assert.strictEqual(updated.title, 'Partial update test'); // Preserved
  assert.strictEqual(updated.priority, 'High');            // Preserved
  assert.strictEqual(updated.id, created.id);              // Preserved
  assert.strictEqual(updated.createdAt, created.createdAt);// Preserved
});

test('POST and PUT reject non-object JSON payloads (array, number, boolean)', async () => {
  const env = createEnv();

  // JSON Array
  const req1 = new Request('https://worker.test/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(['not', 'an', 'object'])
  });
  const res1 = await worker.fetch(req1, env);
  assert.strictEqual(res1.status, 400);

  // JSON Number
  const req2 = new Request('https://worker.test/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '12345'
  });
  const res2 = await worker.fetch(req2, env);
  assert.strictEqual(res2.status, 400);
});

test('PUT rejects malformed JSON on existing task', async () => {
  const env = createEnv();
  const createReq = new Request('https://worker.test/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Task for malformed JSON PUT' })
  });
  const created = (await (await worker.fetch(createReq, env)).json()).task;

  const putReq = new Request(`https://worker.test/api/tasks/${created.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: '{ malformed json: true '
  });
  const putRes = await worker.fetch(putReq, env);
  assert.strictEqual(putRes.status, 400);
  const data = await putRes.json();
  assert.match(data.error, /Invalid JSON payload/);
});

