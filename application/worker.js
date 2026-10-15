/**
 * Student Task Manager - Cloudflare Workers Backend
 * 
 * Architecture:
 * - Serverless runtime: Cloudflare Workers (ES Modules format).
 * - Persistent storage: Cloudflare Workers KV via `env.TASKS_KV` binding.
 * - Single-worker deployment: Serves both the frontend dashboard assets (GET /, /style.css, /script.js)
 *   and the complete REST API (/api/tasks).
 * 
 * Note on Workers KV Consistency:
 * Cloudflare Workers KV is an eventually consistent key-value store optimized for high-read throughput.
 * Writes propagate globally within seconds, but read-modify-write operations are not atomic or transactional.
 */

// Permitted Data Model Enum Values
const VALID_PRIORITIES = ['Low', 'Medium', 'High'];
const VALID_STATUSES = ['Pending', 'In Progress', 'Completed'];
const MAX_TITLE_LENGTH = 200;

// Standard CORS and Content Headers
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400'
};

/**
 * Creates a JSON response with appropriate headers and status code.
 */
function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...extraHeaders
    }
  });
}

/**
 * Creates a standardized error response.
 */
function errorResponse(status, message, extraHeaders = {}) {
  return jsonResponse({ error: message }, status, extraHeaders);
}

/**
 * Validates incoming task payloads.
 */
function validateTaskPayload(payload, isUpdate = false) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, error: 'Request body must be a valid JSON object' };
  }

  const { title, priority, status } = payload;

  // Title validation
  if (!isUpdate || title !== undefined) {
    if (typeof title !== 'string' || title.trim().length === 0) {
      return { valid: false, error: 'Task title is required and cannot be empty' };
    }
    if (title.trim().length > MAX_TITLE_LENGTH) {
      return { valid: false, error: `Task title cannot exceed ${MAX_TITLE_LENGTH} characters` };
    }
  }

  // Priority validation
  if (priority !== undefined && !VALID_PRIORITIES.includes(priority)) {
    return {
      valid: false,
      error: `Invalid priority: "${priority}". Allowed values: ${VALID_PRIORITIES.join(', ')}`
    };
  }

  // Status validation
  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    return {
      valid: false,
      error: `Invalid status: "${status}". Allowed values: ${VALID_STATUSES.join(', ')}`
    };
  }

  return {
    valid: true,
    sanitized: {
      title: title !== undefined ? title.trim() : undefined,
      priority: priority || (isUpdate ? undefined : 'Medium'),
      status: status || (isUpdate ? undefined : 'Pending')
    }
  };
}

/**
 * Main Cloudflare Worker fetch handler.
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method.toUpperCase();

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS
      });
    }

    try {
      // ----------------------------------------------------------------------
      // REST API Routes (/api/tasks and /api/tasks/:id)
      // ----------------------------------------------------------------------
      if (pathname.startsWith('/api/tasks')) {
        // Guard check for KV binding
        if (!env || !env.TASKS_KV) {
          return errorResponse(500, 'TASKS_KV binding is not configured in the worker environment.');
        }

        const subPath = pathname.substring('/api/tasks'.length);

        // Route: /api/tasks (Collection)
        if (subPath === '' || subPath === '/') {
          switch (method) {
            case 'GET':
              return await handleListTasks(env);
            case 'POST':
              return await handleCreateTask(request, env);
            default:
              return errorResponse(405, 'Method not allowed on /api/tasks', {
                'Allow': 'GET, POST, OPTIONS'
              });
          }
        }

        // Route: /api/tasks/:id (Individual Resource)
        const match = subPath.match(/^\/([a-zA-Z0-9_-]+)$/);
        if (match) {
          const taskId = match[1];
          switch (method) {
            case 'GET':
              return await handleGetTask(taskId, env);
            case 'PUT':
              return await handleUpdateTask(taskId, request, env);
            case 'DELETE':
              return await handleDeleteTask(taskId, env);
            default:
              return errorResponse(405, `Method not allowed on /api/tasks/${taskId}`, {
                'Allow': 'GET, PUT, DELETE, OPTIONS'
              });
          }
        }

        return errorResponse(404, 'Invalid API endpoint');
      }

      // ----------------------------------------------------------------------
      // Static Frontend Delivery (Single-Worker Fullstack Hosting)
      // ----------------------------------------------------------------------
      if (method === 'GET') {
        if (pathname === '/' || pathname === '/index.html') {
          return new Response(INDEX_HTML_CONTENT, {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        }

        if (pathname === '/style.css') {
          return new Response(STYLE_CSS_CONTENT, {
            status: 200,
            headers: { 'Content-Type': 'text/css; charset=utf-8' }
          });
        }

        if (pathname === '/script.js') {
          return new Response(SCRIPT_JS_CONTENT, {
            status: 200,
            headers: { 'Content-Type': 'application/javascript; charset=utf-8' }
          });
        }
      }

      // Default Not Found
      return errorResponse(404, `Route not found: ${pathname}`);

    } catch (err) {
      // Internal error handling - safe generic message without leaking internals
      return errorResponse(500, 'An unexpected server error occurred.');
    }
  }
};

// ============================================================================
// REST API Handlers
// ============================================================================

/**
 * GET /api/tasks
 * Lists all tasks stored in Workers KV.
 */
async function handleListTasks(env) {
  const listResult = await env.TASKS_KV.list({ prefix: 'task:' });
  const keys = listResult.keys || [];

  if (keys.length === 0) {
    return jsonResponse({ tasks: [], count: 0 });
  }

  // Fetch individual tasks in parallel
  const taskPromises = keys.map(k => env.TASKS_KV.get(k.name, { type: 'json' }));
  const taskResults = await Promise.all(taskPromises);

  // Filter nulls (in case of race conditions/deletions during listing)
  const validTasks = taskResults.filter(t => t !== null && typeof t === 'object' && t.id);

  // Sort descending by createdAt (newest first)
  validTasks.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return jsonResponse({ tasks: validTasks, count: validTasks.length });
}

/**
 * POST /api/tasks
 * Validates and creates a new task in Workers KV.
 */
async function handleCreateTask(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON payload in request body');
  }

  const validation = validateTaskPayload(body, false);
  if (!validation.valid) {
    return errorResponse(400, validation.error);
  }

  const taskId = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  const newTask = {
    id: taskId,
    title: validation.sanitized.title,
    priority: validation.sanitized.priority,
    status: validation.sanitized.status,
    createdAt
  };

  // Persist to Workers KV
  await env.TASKS_KV.put(`task:${taskId}`, JSON.stringify(newTask));

  return jsonResponse({
    message: 'Task created successfully',
    task: newTask
  }, 201);
}

/**
 * GET /api/tasks/:id
 * Retrieves a single task by ID from Workers KV.
 */
async function handleGetTask(taskId, env) {
  const task = await env.TASKS_KV.get(`task:${taskId}`, { type: 'json' });

  if (!task) {
    return errorResponse(404, `Task with ID "${taskId}" not found`);
  }

  return jsonResponse({ task });
}

/**
 * PUT /api/tasks/:id
 * Updates an existing task in Workers KV, preserving id and createdAt.
 */
async function handleUpdateTask(taskId, request, env) {
  const existingTask = await env.TASKS_KV.get(`task:${taskId}`, { type: 'json' });

  if (!existingTask) {
    return errorResponse(404, `Task with ID "${taskId}" not found`);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON payload in request body');
  }

  const validation = validateTaskPayload(body, true);
  if (!validation.valid) {
    return errorResponse(400, validation.error);
  }

  const updatedTask = {
    id: existingTask.id,
    title: validation.sanitized.title !== undefined ? validation.sanitized.title : existingTask.title,
    priority: validation.sanitized.priority !== undefined ? validation.sanitized.priority : existingTask.priority,
    status: validation.sanitized.status !== undefined ? validation.sanitized.status : existingTask.status,
    createdAt: existingTask.createdAt,
    updatedAt: new Date().toISOString()
  };

  await env.TASKS_KV.put(`task:${taskId}`, JSON.stringify(updatedTask));

  return jsonResponse({
    message: 'Task updated successfully',
    task: updatedTask
  }, 200);
}

/**
 * DELETE /api/tasks/:id
 * Deletes a task from Workers KV.
 */
async function handleDeleteTask(taskId, env) {
  const existingTask = await env.TASKS_KV.get(`task:${taskId}`, { type: 'json' });

  if (!existingTask) {
    return errorResponse(404, `Task with ID "${taskId}" not found`);
  }

  await env.TASKS_KV.delete(`task:${taskId}`);

  return jsonResponse({
    message: 'Task deleted successfully',
    id: taskId
  }, 200);
}

// ============================================================================
// Embedded Static Assets (Enables single-Worker self-contained deployment)
// ============================================================================

const INDEX_HTML_CONTENT = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Student Task Manager | Serverless Productivity Dashboard</title>
  <meta name="description" content="A clean, student-friendly task management dashboard powered by Cloudflare Workers and Workers KV.">
  <link rel="stylesheet" href="style.css">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🎓</text></svg>">
</head>
<body>
  <!-- Header / Navigation -->
  <header class="app-header">
    <div class="header-container">
      <div class="brand">
        <div class="brand-icon" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 3L1 9L12 15L21 10.09V17H23V9L12 3ZM5 13.18V17.18C5 19.94 8.13 22 12 22C15.87 22 19 19.94 19 17.18V13.18L12 17L5 13.18Z"/>
          </svg>
        </div>
        <div class="brand-text">
          <h1 class="brand-title">Student Task Manager</h1>
          <p class="brand-subtitle" style="display: none;">Academic Task Dashboard</p>
        </div>
      </div>
      <div class="header-actions">
        <div class="backend-status" id="backendStatus" title="System Status: Checking connection...">
          <span class="status-dot status-checking" id="statusDot"></span>
          <span class="status-label" id="statusLabel">Connecting...</span>
        </div>
        <button type="button" class="btn btn-primary" id="openCreateModalBtn" aria-haspopup="dialog">
          <svg class="btn-icon" viewBox="0 0 20 20" fill="currentColor" width="16" height="16" aria-hidden="true">
            <path fill-rule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clip-rule="evenodd" />
          </svg>
          Add Task
        </button>
      </div>
    </div>
  </header>

  <!-- Main Container -->
  <main class="app-main">
    <div class="main-container">

      <!-- Welcome Section -->
      <section class="welcome-section" aria-label="Welcome">
        <h2 class="welcome-heading">Your tasks, all in one place</h2>
        <p class="welcome-subtext">Manage assignments, track coursework priorities, and stay organized.</p>
      </section>

      <!-- Metrics / Summary Dashboard -->
      <section class="dashboard-metrics" aria-label="Task Summary Metrics">
        <div class="metric-card metric-all" id="metricCardTotal" role="button" tabindex="0" title="Click to show all tasks">
          <div class="metric-icon metric-icon-all" aria-hidden="true">📋</div>
          <div class="metric-content">
            <span class="metric-label">Total Tasks</span>
            <span class="metric-value" id="metricTotal">0</span>
          </div>
        </div>

        <div class="metric-card metric-pending" id="metricCardPending" role="button" tabindex="0" title="Click to filter by Pending tasks">
          <div class="metric-icon metric-icon-pending" aria-hidden="true">⏳</div>
          <div class="metric-content">
            <span class="metric-label">Pending</span>
            <span class="metric-value" id="metricPending">0</span>
          </div>
        </div>

        <div class="metric-card metric-progress" id="metricCardProgress" role="button" tabindex="0" title="Click to filter by In Progress tasks">
          <div class="metric-icon metric-icon-progress" aria-hidden="true">⚡</div>
          <div class="metric-content">
            <span class="metric-label">In Progress</span>
            <span class="metric-value" id="metricInProgress">0</span>
          </div>
        </div>

        <div class="metric-card metric-completed" id="metricCardCompleted" role="button" tabindex="0" title="Click to filter by Completed tasks">
          <div class="metric-icon metric-icon-completed" aria-hidden="true">✅</div>
          <div class="metric-content">
            <span class="metric-label">Completed</span>
            <span class="metric-value" id="metricCompleted">0</span>
          </div>
        </div>
      </section>

      <!-- Filter, Search, and Sort Controls Toolbar -->
      <section class="toolbar-section" aria-label="Task filters and search">
        <div class="search-box">
          <svg class="search-icon" viewBox="0 0 20 20" fill="currentColor" width="16" height="16" aria-hidden="true">
            <path fill-rule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clip-rule="evenodd" />
          </svg>
          <input type="text" id="searchInput" class="search-input" placeholder="Search tasks by title..." aria-label="Search tasks by title">
          <button type="button" class="search-clear-btn" id="searchClearBtn" aria-label="Clear search" hidden>&times;</button>
        </div>

        <div class="filters-group">
          <div class="filter-control">
            <label for="statusFilter" class="filter-label">Status</label>
            <select id="statusFilter" class="select-input">
              <option value="ALL">All Statuses</option>
              <option value="Pending">Pending</option>
              <option value="In Progress">In Progress</option>
              <option value="Completed">Completed</option>
            </select>
          </div>

          <div class="filter-control">
            <label for="priorityFilter" class="filter-label">Priority</label>
            <select id="priorityFilter" class="select-input">
              <option value="ALL">All Priorities</option>
              <option value="High">High</option>
              <option value="Medium">Medium</option>
              <option value="Low">Low</option>
            </select>
          </div>

          <div class="filter-control">
            <label for="sortOrder" class="filter-label">Sort</label>
            <select id="sortOrder" class="select-input">
              <option value="newest">Newest First</option>
              <option value="oldest">Oldest First</option>
              <option value="priority-desc">Priority: High to Low</option>
              <option value="title-asc">Title: A to Z</option>
            </select>
          </div>

          <button type="button" class="btn btn-secondary btn-icon-only" id="refreshTasksBtn" title="Refresh task list" aria-label="Refresh tasks">
            <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16" aria-hidden="true">
              <path fill-rule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.047a1 1 0 011.885-.666A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566l-.391-.286z" clip-rule="evenodd" />
            </svg>
          </button>
        </div>
      </section>

      <!-- Active Filters Display -->
      <div class="active-filters-bar" id="activeFiltersBar" hidden>
        <span class="active-filters-label">Active filters:</span>
        <div class="active-filters-chips" id="activeFiltersChips"></div>
        <button type="button" class="btn-link" id="resetFiltersBtn">Reset All</button>
      </div>

      <!-- Task List Container -->
      <section class="task-list-section" aria-label="Task List">
        <!-- Loading State -->
        <div class="loading-state" id="loadingState" aria-live="polite">
          <div class="spinner" aria-hidden="true"></div>
          <p class="loading-text">Loading tasks from Cloudflare Workers KV...</p>
        </div>

        <!-- Error State -->
        <div class="error-banner" id="errorBanner" role="alert" hidden style="display: none;">
          <div class="error-icon" aria-hidden="true">⚠️</div>
          <div class="error-content">
            <h3 class="error-title" id="errorTitle">Failed to load tasks</h3>
            <p class="error-message" id="errorMessage">Unable to reach the serverless backend.</p>
          </div>
          <button type="button" class="btn btn-secondary btn-sm" id="errorRetryBtn">Retry</button>
        </div>

        <!-- Empty State -->
        <div class="empty-state" id="emptyState" hidden style="display: none;">
          <div class="empty-icon" aria-hidden="true">📝</div>
          <h2 class="empty-title" id="emptyTitle">No tasks found</h2>
          <p class="empty-description" id="emptyDescription">You don't have any tasks scheduled. Click 'Add Task' to get started!</p>
          <button type="button" class="btn btn-primary" id="emptyActionBtn">Create Your First Task</button>
        </div>

        <!-- Tasks Grid / Rows -->
        <div class="tasks-grid" id="tasksGrid" role="list">
          <!-- Rendered dynamically via JavaScript -->
        </div>
      </section>

    </div>
  </main>

  <!-- Create / Edit Task Modal Dialog -->
  <div class="modal-overlay" id="taskModalOverlay" role="dialog" aria-modal="true" aria-labelledby="modalTitle" hidden>
    <div class="modal-dialog">
      <div class="modal-header">
        <h2 class="modal-title" id="modalTitle">Create New Task</h2>
        <button type="button" class="modal-close-btn" id="modalCloseBtn" aria-label="Close dialog">&times;</button>
      </div>
      <form id="taskForm" class="modal-form" novalidate>
        <input type="hidden" id="taskId" name="taskId" value="">

        <div class="form-group">
          <label for="taskTitle" class="form-label">
            Task Title <span class="required-indicator">*</span>
          </label>
          <input type="text" id="taskTitle" name="taskTitle" class="form-input" placeholder="e.g. Complete Operating Systems Assignment 3" maxlength="200" required aria-describedby="titleValidationMsg">
          <div class="field-meta">
            <span class="validation-message" id="titleValidationMsg" role="alert"></span>
            <span class="char-counter" id="titleCharCount">0/200</span>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label for="taskPriority" class="form-label">Priority</label>
            <select id="taskPriority" name="taskPriority" class="form-select">
              <option value="Low">Low</option>
              <option value="Medium" selected>Medium</option>
              <option value="High">High</option>
            </select>
          </div>

          <div class="form-group">
            <label for="taskStatus" class="form-label">Status</label>
            <select id="taskStatus" name="taskStatus" class="form-select">
              <option value="Pending" selected>Pending</option>
              <option value="In Progress">In Progress</option>
              <option value="Completed">Completed</option>
            </select>
          </div>
        </div>

        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" id="modalCancelBtn">Cancel</button>
          <button type="submit" class="btn btn-primary" id="modalSubmitBtn">
            <span class="btn-spinner" id="modalBtnSpinner" hidden aria-hidden="true"></span>
            <span id="modalSubmitBtnText">Save Task</span>
          </button>
        </div>
      </form>
    </div>
  </div>

  <!-- Delete Confirmation Modal Dialog -->
  <div class="modal-overlay" id="deleteModalOverlay" role="dialog" aria-modal="true" aria-labelledby="deleteModalTitle" hidden>
    <div class="modal-dialog modal-dialog-sm">
      <div class="modal-header modal-header-danger">
        <div class="danger-header-icon" aria-hidden="true">🗑️</div>
        <h2 class="modal-title" id="deleteModalTitle">Delete Task</h2>
        <button type="button" class="modal-close-btn" id="deleteModalCloseBtn" aria-label="Close dialog">&times;</button>
      </div>
      <div class="modal-body">
        <p class="delete-warning-text">Are you sure you want to permanently delete this task?</p>
        <p class="delete-task-preview" id="deleteTaskTitlePreview">"Task title"</p>
        <p class="delete-subtext">This action cannot be undone.</p>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" id="deleteCancelBtn">Cancel</button>
        <button type="button" class="btn btn-danger" id="deleteConfirmBtn">
          <span class="btn-spinner" id="deleteBtnSpinner" hidden aria-hidden="true"></span>
          <span id="deleteConfirmBtnText">Yes, Delete Task</span>
        </button>
      </div>
    </div>
  </div>

  <!-- Toast Notification Container -->
  <div class="toast-container" id="toastContainer" aria-live="polite" aria-atomic="true"></div>

  <!-- Footer -->
  <footer class="app-footer">
    <div class="footer-container">
      <p>Student Task Manager &bull; Serverless backend on Cloudflare Workers &bull; Storage via Workers KV</p>
    </div>
  </footer>

  <script src="script.js"></script>
</body>
</html>
`;

const STYLE_CSS_CONTENT = `/* ==========================================================================
   Student Task Manager - Mint Green, Teal & White Stylesheet
   Clean, practical, student-friendly design with a calming mint & teal palette
   ========================================================================== */

:root {
  /* Primary Color Palette */
  --primary: #167D78;
  --primary-hover: #126561;
  --primary-text: #FFFFFF;
  --dark-teal: #145A56;
  --navy: #145A56;

  /* Surfaces & Backgrounds */
  --bg-primary: #F0F9F8;
  --bg-surface: #FFFFFF;
  --bg-surface-hover: #F5FBFA;
  --bg-surface-soft: #D9F1EC;
  --bg-input: #FFFFFF;

  /* Text & Neutral Colors */
  --text-primary: #183D3A;
  --text-secondary: #627C79;
  --text-muted: #8FA6A3;

  /* Borders */
  --border: #D5E8E4;
  --border-subtle: #E3F1EE;
  --border-focus: #167D78;

  /* Priority Labels */
  --priority-high-bg: #FCE8E6;
  --priority-high-border: #F5C2C7;
  --priority-high-text: #C5221F;

  --priority-med-bg: #FEF7E0;
  --priority-med-border: #FEEFC3;
  --priority-med-text: #B06000;

  --priority-low-bg: #D9F1EC;
  --priority-low-border: #BCE5DC;
  --priority-low-text: #145A56;

  /* Status Labels */
  --status-pending-bg: #EAF3F1;
  --status-pending-border: #D5E8E4;
  --status-pending-text: #627C79;

  --status-progress-bg: #D9F1EC;
  --status-progress-border: #BCE5DC;
  --status-progress-text: #167D78;

  --status-completed-bg: #DFF4EE;
  --status-completed-border: #BCE5DC;
  --status-completed-text: #145A56;

  /* Restrained Indicators */
  --success: #167D78;
  --success-bg: #D9F1EC;
  --success-border: #BCE5DC;

  --danger: #D93025;
  --danger-hover: #B3261E;
  --danger-bg: #FCE8E6;
  --danger-border: #F5C2C7;

  /* Geometry & Shadows */
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;
  --radius-full: 9999px;

  --shadow-subtle: 0 1px 2px 0 rgba(20, 90, 86, 0.06);
  --shadow-card: 0 1px 3px 0 rgba(20, 90, 86, 0.08), 0 1px 2px 0 rgba(20, 90, 86, 0.04);
  --shadow-modal: 0 4px 16px 0 rgba(24, 61, 58, 0.18);

  /* Layout */
  --container-max-width: 980px;
  --font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}

/* ==========================================================================
   CSS Reset & Base Styles
   ========================================================================== */

*, *::before, *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

[hidden] {
  display: none !important;
}

body {
  font-family: var(--font-family);
  background-color: var(--bg-primary);
  color: var(--text-primary);
  line-height: 1.5;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  -webkit-font-smoothing: antialiased;
}

button, input, select, textarea {
  font: inherit;
  color: inherit;
}

button {
  cursor: pointer;
  background: none;
  border: none;
}

:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}

/* ==========================================================================
   Header Navigation
   ========================================================================== */

.app-header {
  background-color: var(--bg-surface);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 50;
}

.header-container {
  max-width: var(--container-max-width);
  margin: 0 auto;
  padding: 0.875rem 1.5rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.25rem;
}

.brand {
  display: flex;
  align-items: center;
  gap: 0.625rem;
}

.brand-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background-color: var(--bg-surface-soft);
  border-radius: var(--radius-md);
  color: var(--primary);
}

.brand-title {
  font-size: 1.1875rem;
  font-weight: 600;
  color: var(--dark-teal);
  letter-spacing: -0.01em;
}

.brand-subtitle {
  display: none;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

/* Connection Status Badge */
.backend-status {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.25rem 0.625rem;
  background-color: var(--bg-surface-hover);
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  font-size: 0.75rem;
  color: var(--text-secondary);
  font-weight: 500;
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.status-checking {
  background-color: #B06000;
}

.status-online {
  background-color: var(--primary);
}

.status-offline {
  background-color: #D93025;
}

/* ==========================================================================
   Buttons
   ========================================================================== */

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  padding: 0.5rem 1rem;
  border-radius: var(--radius-md);
  font-weight: 500;
  font-size: 0.875rem;
  transition: background-color 0.15s ease, border-color 0.15s ease;
  white-space: nowrap;
}

.btn-primary {
  background-color: var(--primary);
  color: var(--primary-text);
  border: 1px solid transparent;
}

.btn-primary:hover {
  background-color: var(--primary-hover);
}

.btn-secondary {
  background-color: var(--bg-surface);
  color: var(--text-primary);
  border: 1px solid var(--border);
}

.btn-secondary:hover {
  background-color: var(--bg-surface-hover);
  border-color: #BCE5DC;
}

.btn-danger {
  background-color: var(--danger);
  color: #FFFFFF;
  border: 1px solid transparent;
}

.btn-danger:hover {
  background-color: var(--danger-hover);
}

.btn-sm {
  padding: 0.35rem 0.65rem;
  font-size: 0.8125rem;
}

.btn-icon-only {
  padding: 0.5rem;
}

.btn-link {
  color: var(--primary);
  font-size: 0.75rem;
  text-decoration: underline;
  padding: 0.2rem 0.4rem;
  font-weight: 500;
}

.btn-link:hover {
  color: var(--primary-hover);
}

/* ==========================================================================
   Main Content Layout
   ========================================================================== */

.app-main {
  flex: 1;
  padding: 1.5rem 1.5rem 2.5rem;
}

.main-container {
  max-width: var(--container-max-width);
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

/* ==========================================================================
   Welcome Section
   ========================================================================== */

.welcome-section {
  padding: 0.25rem 0;
}

.welcome-heading {
  font-size: 1.375rem;
  font-weight: 600;
  color: var(--dark-teal);
  margin-bottom: 0.25rem;
  letter-spacing: -0.01em;
}

.welcome-subtext {
  font-size: 0.875rem;
  color: var(--text-secondary);
}

/* ==========================================================================
   Dashboard Metrics
   ========================================================================== */

.dashboard-metrics {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.875rem;
}

.metric-card {
  background-color: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 0.875rem 1rem;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  box-shadow: var(--shadow-subtle);
  cursor: pointer;
  transition: border-color 0.15s ease, background-color 0.15s ease;
  user-select: none;
}

.metric-card:hover {
  border-color: #BCE5DC;
  background-color: var(--bg-surface-hover);
}

.metric-card.active-metric-filter {
  border-color: var(--primary);
  background-color: var(--bg-surface-soft);
}

.metric-icon {
  font-size: 1.125rem;
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  background-color: var(--bg-surface-soft);
  color: var(--primary);
  flex-shrink: 0;
}

.metric-content {
  display: flex;
  flex-direction: column;
}

.metric-label {
  font-size: 0.75rem;
  color: var(--text-secondary);
  font-weight: 500;
}

.metric-value {
  font-size: 1.375rem;
  font-weight: 700;
  color: var(--dark-teal);
  line-height: 1.2;
}

/* ==========================================================================
   Toolbar & Filters
   ========================================================================== */

.toolbar-section {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.875rem;
  flex-wrap: wrap;
  background-color: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 0.75rem 1rem;
  box-shadow: var(--shadow-subtle);
}

.search-box {
  position: relative;
  flex: 1;
  min-width: 220px;
}

.search-icon {
  position: absolute;
  left: 0.75rem;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-secondary);
  pointer-events: none;
}

.search-input {
  width: 100%;
  background-color: #F5FBFA;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 0.45rem 2rem 0.45rem 2.25rem;
  color: var(--text-primary);
  font-size: 0.875rem;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

.search-input:focus {
  background-color: #FFFFFF;
  border-color: var(--primary);
  outline: none;
}

.search-clear-btn {
  position: absolute;
  right: 0.625rem;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-muted);
  font-size: 1.125rem;
  line-height: 1;
}

.search-clear-btn:hover {
  color: var(--text-primary);
}

.filters-group {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.filter-control {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

.filter-label {
  font-size: 0.75rem;
  color: var(--text-secondary);
  font-weight: 500;
}

.select-input {
  background-color: #FFFFFF;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 0.4rem 1.75rem 0.4rem 0.625rem;
  color: var(--text-primary);
  font-size: 0.8125rem;
  cursor: pointer;
}

.select-input:focus {
  border-color: var(--primary);
  outline: none;
}

/* Active Filter Chips */
.active-filters-bar {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  font-size: 0.75rem;
  color: var(--text-secondary);
  flex-wrap: wrap;
}

.active-filters-chips {
  display: flex;
  gap: 0.375rem;
  flex-wrap: wrap;
}

.filter-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.2rem 0.5rem;
  background-color: var(--bg-surface-soft);
  border: 1px solid #BCE5DC;
  border-radius: var(--radius-full);
  color: var(--primary);
  font-size: 0.75rem;
  font-weight: 500;
}

.filter-chip-remove {
  cursor: pointer;
  font-size: 0.875rem;
  line-height: 1;
  color: var(--primary);
}

/* ==========================================================================
   Task List Section & Rows
   ========================================================================== */

.task-list-section {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.tasks-grid {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
}

/* Task Item: Clean White Panel / Row */
.task-card {
  background-color: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 0.875rem 1.125rem;
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
  box-shadow: var(--shadow-subtle);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
  position: relative;
  overflow: hidden;
}

.task-card::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  width: 4px;
}

.task-card.priority-high::before {
  background-color: #D93025;
}

.task-card.priority-medium::before {
  background-color: #F9AB00;
}

.task-card.priority-low::before {
  background-color: var(--primary);
}

.task-card:hover {
  border-color: #BCE5DC;
  box-shadow: var(--shadow-card);
}

.task-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.task-badges {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  flex-wrap: wrap;
}

/* Badges */
.badge {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.175rem 0.5rem;
  border-radius: var(--radius-sm);
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.01em;
}

/* Priority Badges */
.badge-priority-high {
  background-color: var(--priority-high-bg);
  border: 1px solid var(--priority-high-border);
  color: var(--priority-high-text);
}

.badge-priority-medium {
  background-color: var(--priority-med-bg);
  border: 1px solid var(--priority-med-border);
  color: var(--priority-med-text);
}

.badge-priority-low {
  background-color: var(--priority-low-bg);
  border: 1px solid var(--priority-low-border);
  color: var(--priority-low-text);
}

/* Status Badges */
.badge-status-pending {
  background-color: var(--status-pending-bg);
  border: 1px solid var(--status-pending-border);
  color: var(--status-pending-text);
}

.badge-status-in-progress {
  background-color: var(--status-progress-bg);
  border: 1px solid var(--status-progress-border);
  color: var(--status-progress-text);
}

.badge-status-completed {
  background-color: var(--status-completed-bg);
  border: 1px solid var(--status-completed-border);
  color: var(--status-completed-text);
}

/* Task Title - Most Prominent */
.task-title {
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.4;
  word-break: break-word;
}

.task-card.status-completed .task-title {
  color: var(--text-muted);
  text-decoration: line-through;
}

.task-meta {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.75rem;
  color: var(--text-secondary);
}

.task-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding-top: 0.5rem;
  border-top: 1px solid var(--border-subtle);
}

.task-actions {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

.btn-action {
  padding: 0.25rem 0.5rem;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: 0.75rem;
  font-weight: 500;
  border: 1px solid var(--border);
  background-color: #FFFFFF;
  transition: all 0.15s ease;
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}

.btn-action:hover {
  background-color: var(--bg-surface-soft);
  color: var(--primary);
  border-color: #BCE5DC;
}

.btn-action-delete:hover {
  background-color: var(--danger-bg);
  color: var(--danger);
  border-color: var(--danger-border);
}

/* Quick Status Toggle */
.quick-status-select {
  background-color: #FFFFFF;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0.2rem 0.5rem;
  font-size: 0.75rem;
  color: var(--text-secondary);
  font-weight: 500;
  cursor: pointer;
}

.quick-status-select:focus {
  border-color: var(--primary);
  outline: none;
}

/* ==========================================================================
   State Displays: Loading, Error, Empty
   ========================================================================== */

.loading-state,
.empty-state {
  text-align: center;
  padding: 3rem 1.5rem;
  background-color: var(--bg-surface);
  border: 1px dashed var(--border);
  border-radius: var(--radius-lg);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
}

.spinner {
  width: 32px;
  height: 32px;
  border: 3px solid #D9F1EC;
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.loading-text {
  color: var(--text-secondary);
  font-size: 0.875rem;
}

.empty-icon {
  font-size: 2.25rem;
  line-height: 1;
}

.empty-title {
  font-size: 1.125rem;
  font-weight: 600;
  color: var(--dark-teal);
}

.empty-description {
  color: var(--text-secondary);
  max-width: 400px;
  font-size: 0.875rem;
}

/* Error Banner */
.error-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.875rem 1.125rem;
  background-color: var(--danger-bg);
  border: 1px solid var(--danger-border);
  border-radius: var(--radius-md);
}

.error-icon {
  font-size: 1.25rem;
}

.error-content {
  flex: 1;
}

.error-title {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--danger);
}

.error-message {
  font-size: 0.8125rem;
  color: var(--text-secondary);
}

/* ==========================================================================
   Modals
   ========================================================================== */

.modal-overlay {
  position: fixed;
  inset: 0;
  background-color: rgba(20, 50, 48, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
  z-index: 100;
}

.modal-dialog {
  background-color: #FFFFFF;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-modal);
  width: 100%;
  max-width: 480px;
  overflow: hidden;
}

.modal-dialog-sm {
  max-width: 420px;
}

.modal-header {
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  background-color: #F5FBFA;
}

.modal-header-danger {
  background-color: var(--danger-bg);
}

.danger-header-icon {
  font-size: 1.25rem;
}

.modal-title {
  font-size: 1.0625rem;
  font-weight: 600;
  color: var(--dark-teal);
}

.modal-close-btn {
  font-size: 1.25rem;
  line-height: 1;
  color: var(--text-secondary);
  padding: 0.25rem;
  border-radius: var(--radius-sm);
}

.modal-close-btn:hover {
  color: var(--text-primary);
}

.modal-form,
.modal-body {
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.875rem;
}

.form-label {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--text-primary);
}

.required-indicator {
  color: var(--danger);
}

.form-input,
.form-select {
  background-color: #FFFFFF;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 0.5rem 0.75rem;
  color: var(--text-primary);
  font-size: 0.875rem;
  transition: border-color 0.15s ease;
}

.form-input:focus,
.form-select:focus {
  border-color: var(--primary);
  outline: none;
}

.field-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.75rem;
}

.validation-message {
  color: var(--danger);
}

.char-counter {
  color: var(--text-muted);
  margin-left: auto;
}

.delete-warning-text {
  font-size: 0.875rem;
  color: var(--text-primary);
}

.delete-task-preview {
  font-size: 0.9375rem;
  font-weight: 600;
  color: var(--danger);
  background-color: var(--danger-bg);
  padding: 0.625rem 0.875rem;
  border-radius: var(--radius-md);
  border-left: 3px solid var(--danger);
  word-break: break-word;
}

.delete-subtext {
  font-size: 0.75rem;
  color: var(--text-secondary);
}

.modal-footer {
  padding: 0.875rem 1.25rem;
  background-color: #F5FBFA;
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.625rem;
}

.btn-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.4);
  border-top-color: #FFFFFF;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  display: inline-block;
}

/* ==========================================================================
   Toast Notifications
   ========================================================================== */

.toast-container {
  position: fixed;
  bottom: 1.25rem;
  right: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  z-index: 200;
  max-width: 360px;
}

.toast {
  background-color: #FFFFFF;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 0.75rem 1rem;
  box-shadow: var(--shadow-card);
  display: flex;
  align-items: center;
  gap: 0.625rem;
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.toast-success {
  border-left: 4px solid var(--success);
}

.toast-error {
  border-left: 4px solid var(--danger);
}

.toast-info {
  border-left: 4px solid var(--primary);
}

.toast-icon {
  font-size: 1rem;
  flex-shrink: 0;
}

.toast-message {
  font-size: 0.8125rem;
  color: var(--text-primary);
  flex: 1;
}

/* ==========================================================================
   Footer
   ========================================================================== */

.app-footer {
  border-top: 1px solid var(--border);
  padding: 1.25rem;
  text-align: center;
  color: var(--text-secondary);
  font-size: 0.75rem;
  margin-top: auto;
  background-color: #FFFFFF;
}

/* ==========================================================================
   Responsive Adaptations
   ========================================================================== */

@media (max-width: 840px) {
  .dashboard-metrics {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 600px) {
  .header-container {
    flex-direction: column;
    align-items: stretch;
    gap: 0.75rem;
  }

  .header-actions {
    justify-content: space-between;
  }

  .dashboard-metrics {
    grid-template-columns: 1fr;
  }

  .toolbar-section {
    flex-direction: column;
    align-items: stretch;
  }

  .filters-group {
    flex-direction: column;
    align-items: stretch;
  }

  .filter-control {
    justify-content: space-between;
  }

  .form-row {
    grid-template-columns: 1fr;
  }

  .task-card-footer {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
  }

  .task-actions {
    width: 100%;
    justify-content: flex-end;
  }
}
`;

const SCRIPT_JS_CONTENT = `/**
 * Student Task Manager - Frontend Controller
 * Integrates with Cloudflare Workers REST API & Workers KV backend.
 */

(function () {
  'use strict';

  // Configurable API base URL (defaults to relative root for same-origin Worker deployment)
  const API_BASE = (window.TASK_MANAGER_API_BASE || '').replace(/\\/$/, '');

  // Application State
  const state = {
    tasks: [],
    loading: false,
    filter: {
      status: 'ALL',
      priority: 'ALL',
      search: '',
      sort: 'newest'
    },
    editingTaskId: null,
    deletingTaskId: null
  };

  // DOM Elements Cache
  const elements = {
    // Backend status
    statusDot: document.getElementById('statusDot'),
    statusLabel: document.getElementById('statusLabel'),
    backendStatus: document.getElementById('backendStatus'),

    // Metrics
    metricTotal: document.getElementById('metricTotal'),
    metricPending: document.getElementById('metricPending'),
    metricInProgress: document.getElementById('metricInProgress'),
    metricCompleted: document.getElementById('metricCompleted'),
    metricCardTotal: document.getElementById('metricCardTotal'),
    metricCardPending: document.getElementById('metricCardPending'),
    metricCardProgress: document.getElementById('metricCardProgress'),
    metricCardCompleted: document.getElementById('metricCardCompleted'),

    // Toolbar
    searchInput: document.getElementById('searchInput'),
    searchClearBtn: document.getElementById('searchClearBtn'),
    statusFilter: document.getElementById('statusFilter'),
    priorityFilter: document.getElementById('priorityFilter'),
    sortOrder: document.getElementById('sortOrder'),
    refreshTasksBtn: document.getElementById('refreshTasksBtn'),
    activeFiltersBar: document.getElementById('activeFiltersBar'),
    activeFiltersChips: document.getElementById('activeFiltersChips'),
    resetFiltersBtn: document.getElementById('resetFiltersBtn'),

    // Content & States
    tasksGrid: document.getElementById('tasksGrid'),
    loadingState: document.getElementById('loadingState'),
    emptyState: document.getElementById('emptyState'),
    emptyTitle: document.getElementById('emptyTitle'),
    emptyDescription: document.getElementById('emptyDescription'),
    emptyActionBtn: document.getElementById('emptyActionBtn'),
    errorBanner: document.getElementById('errorBanner'),
    errorTitle: document.getElementById('errorTitle'),
    errorMessage: document.getElementById('errorMessage'),
    errorRetryBtn: document.getElementById('errorRetryBtn'),

    // Create / Edit Modal
    openCreateModalBtn: document.getElementById('openCreateModalBtn'),
    taskModalOverlay: document.getElementById('taskModalOverlay'),
    modalTitle: document.getElementById('modalTitle'),
    modalCloseBtn: document.getElementById('modalCloseBtn'),
    modalCancelBtn: document.getElementById('modalCancelBtn'),
    taskForm: document.getElementById('taskForm'),
    taskIdInput: document.getElementById('taskId'),
    taskTitleInput: document.getElementById('taskTitle'),
    taskPriorityInput: document.getElementById('taskPriority'),
    taskStatusInput: document.getElementById('taskStatus'),
    titleValidationMsg: document.getElementById('titleValidationMsg'),
    titleCharCount: document.getElementById('titleCharCount'),
    modalSubmitBtn: document.getElementById('modalSubmitBtn'),
    modalSubmitBtnText: document.getElementById('modalSubmitBtnText'),
    modalBtnSpinner: document.getElementById('modalBtnSpinner'),

    // Delete Modal
    deleteModalOverlay: document.getElementById('deleteModalOverlay'),
    deleteModalCloseBtn: document.getElementById('deleteModalCloseBtn'),
    deleteCancelBtn: document.getElementById('deleteCancelBtn'),
    deleteConfirmBtn: document.getElementById('deleteConfirmBtn'),
    deleteConfirmBtnText: document.getElementById('deleteConfirmBtnText'),
    deleteBtnSpinner: document.getElementById('deleteBtnSpinner'),
    deleteTaskTitlePreview: document.getElementById('deleteTaskTitlePreview'),

    // Toast Container
    toastContainer: document.getElementById('toastContainer')
  };

  // ==========================================================================
  // API Client Methods (Cloudflare Workers REST API)
  // ==========================================================================

  async function apiRequest(endpoint, options = {}) {
    const url = \`\${API_BASE}\${endpoint}\`;
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };

    try {
      const response = await fetch(url, { ...options, headers });
      const contentType = response.headers.get('content-type') || '';
      const isJson = contentType.includes('application/json');
      const data = isJson ? await response.json() : await response.text();

      if (!response.ok) {
        const errorMsg = (data && data.error) ? data.error : \`HTTP Error \${response.status}: \${response.statusText}\`;
        throw new Error(errorMsg);
      }

      setBackendOnline(true);
      return data;
    } catch (err) {
      setBackendOnline(false);
      throw err;
    }
  }

  async function fetchTasksFromAPI() {
    const result = await apiRequest('/api/tasks', { method: 'GET' });
    if (Array.isArray(result)) return result;
    if (result && Array.isArray(result.tasks)) return result.tasks;
    return [];
  }

  async function createTaskInAPI(taskPayload) {
    return await apiRequest('/api/tasks', {
      method: 'POST',
      body: JSON.stringify(taskPayload)
    });
  }

  async function updateTaskInAPI(taskId, updatePayload) {
    return await apiRequest(\`/api/tasks/\${encodeURIComponent(taskId)}\`, {
      method: 'PUT',
      body: JSON.stringify(updatePayload)
    });
  }

  async function deleteTaskInAPI(taskId) {
    return await apiRequest(\`/api/tasks/\${encodeURIComponent(taskId)}\`, {
      method: 'DELETE'
    });
  }

  // ==========================================================================
  // Application Data Flow & Refresh
  // ==========================================================================

  async function loadTasks() {
    state.loading = true;
    showLoading(true);
    hideError();

    try {
      const tasks = await fetchTasksFromAPI();
      state.tasks = tasks;
      updateMetrics();
      renderTasks();
    } catch (err) {
      showError('Failed to fetch tasks', err.message || 'The serverless backend is currently unreachable.');
    } finally {
      state.loading = false;
      showLoading(false);
    }
  }

  // ==========================================================================
  // Metrics & Filtering Logic
  // ==========================================================================

  function updateMetrics() {
    const total = state.tasks.length;
    let pending = 0;
    let inProgress = 0;
    let completed = 0;

    for (const t of state.tasks) {
      if (t.status === 'Pending') pending++;
      else if (t.status === 'In Progress') inProgress++;
      else if (t.status === 'Completed') completed++;
    }

    elements.metricTotal.textContent = total;
    elements.metricPending.textContent = pending;
    elements.metricInProgress.textContent = inProgress;
    elements.metricCompleted.textContent = completed;

    // Highlight active metric filter card
    elements.metricCardTotal.classList.toggle('active-metric-filter', state.filter.status === 'ALL');
    elements.metricCardPending.classList.toggle('active-metric-filter', state.filter.status === 'Pending');
    elements.metricCardProgress.classList.toggle('active-metric-filter', state.filter.status === 'In Progress');
    elements.metricCardCompleted.classList.toggle('active-metric-filter', state.filter.status === 'Completed');
  }

  function getFilteredAndSortedTasks() {
    const query = state.filter.search.trim().toLowerCase();
    const status = state.filter.status;
    const priority = state.filter.priority;

    let list = state.tasks.filter(task => {
      // Status filter
      if (status !== 'ALL' && task.status !== status) return false;
      // Priority filter
      if (priority !== 'ALL' && task.priority !== priority) return false;
      // Search filter
      if (query && !task.title.toLowerCase().includes(query)) return false;
      return true;
    });

    // Sorting
    const priorityWeight = { 'High': 3, 'Medium': 2, 'Low': 1 };

    list.sort((a, b) => {
      if (state.filter.sort === 'newest') {
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      } else if (state.filter.sort === 'oldest') {
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      } else if (state.filter.sort === 'priority-desc') {
        const weightDiff = (priorityWeight[b.priority] || 0) - (priorityWeight[a.priority] || 0);
        if (weightDiff !== 0) return weightDiff;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      } else if (state.filter.sort === 'title-asc') {
        return a.title.localeCompare(b.title);
      }
      return 0;
    });

    return list;
  }

  // ==========================================================================
  // Render View Components
  // ==========================================================================

  function renderTasks() {
    const filteredTasks = getFilteredAndSortedTasks();
    renderActiveFilterChips();

    elements.tasksGrid.innerHTML = '';

    if (state.tasks.length === 0) {
      elements.emptyTitle.textContent = 'No tasks yet';
      elements.emptyDescription.textContent = "You don't have any tasks scheduled. Click 'Add Task' to create your first task!";
      elements.emptyActionBtn.textContent = 'Create Your First Task';
      elements.emptyActionBtn.onclick = () => openCreateModal();
      elements.emptyState.hidden = false;
      elements.emptyState.style.display = 'flex';
      return;
    }

    if (filteredTasks.length === 0) {
      elements.emptyTitle.textContent = 'No matching tasks';
      elements.emptyDescription.textContent = 'No tasks match your current filter and search criteria.';
      elements.emptyActionBtn.textContent = 'Reset Filters';
      elements.emptyActionBtn.onclick = () => resetFilters();
      elements.emptyState.hidden = false;
      elements.emptyState.style.display = 'flex';
      return;
    }

    elements.emptyState.hidden = true;
    elements.emptyState.style.display = 'none';

    for (const task of filteredTasks) {
      const card = createTaskCard(task);
      elements.tasksGrid.appendChild(card);
    }
  }

  function createTaskCard(task) {
    const card = document.createElement('article');
    card.className = \`task-card priority-\${(task.priority || 'medium').toLowerCase()} status-\${slugify(task.status)}\`;
    card.setAttribute('role', 'listitem');
    card.setAttribute('data-id', task.id);

    const formattedDate = formatDate(task.createdAt);

    card.innerHTML = \`
      <div class="task-card-header">
        <div class="task-badges">
          <span class="badge badge-priority-\${(task.priority || 'medium').toLowerCase()}">
            \${escapeHtml(task.priority)}
          </span>
          <span class="badge badge-status-\${slugify(task.status)}">
            \${escapeHtml(task.status)}
          </span>
        </div>
        <select class="quick-status-select" aria-label="Change status for \${escapeHtml(task.title)}" data-action="quick-status">
          <option value="Pending" \${task.status === 'Pending' ? 'selected' : ''}>Pending</option>
          <option value="In Progress" \${task.status === 'In Progress' ? 'selected' : ''}>In Progress</option>
          <option value="Completed" \${task.status === 'Completed' ? 'selected' : ''}>Completed</option>
        </select>
      </div>

      <h3 class="task-title">\${escapeHtml(task.title)}</h3>

      <div class="task-meta">
        <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14" aria-hidden="true">
          <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clip-rule="evenodd" />
        </svg>
        <time datetime="\${escapeHtml(task.createdAt)}">Created \${formattedDate}</time>
      </div>

      <div class="task-card-footer">
        <span class="task-id-text" style="font-size: 0.6875rem; color: var(--text-muted); font-family: monospace;">
          ID: \${escapeHtml(task.id ? task.id.substring(0, 8) : '')}...
        </span>
        <div class="task-actions">
          <button type="button" class="btn-action btn-action-edit" data-action="edit" title="Edit task" aria-label="Edit task \${escapeHtml(task.title)}">
            <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14" aria-hidden="true">
              <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
            </svg>
            Edit
          </button>
          <button type="button" class="btn-action btn-action-delete" data-action="delete" title="Delete task" aria-label="Delete task \${escapeHtml(task.title)}">
            <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14" aria-hidden="true">
              <path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd" />
            </svg>
            Delete
          </button>
        </div>
      </div>
    \`;

    // Event Listeners for actions
    const editBtn = card.querySelector('[data-action="edit"]');
    const deleteBtn = card.querySelector('[data-action="delete"]');
    const quickStatusSelect = card.querySelector('[data-action="quick-status"]');

    editBtn.addEventListener('click', () => openEditModal(task));
    deleteBtn.addEventListener('click', () => openDeleteModal(task));
    quickStatusSelect.addEventListener('change', async (e) => {
      const newStatus = e.target.value;
      await handleQuickStatusChange(task, newStatus);
    });

    return card;
  }

  function renderActiveFilterChips() {
    const hasStatus = state.filter.status !== 'ALL';
    const hasPriority = state.filter.priority !== 'ALL';
    const hasSearch = state.filter.search.trim().length > 0;

    elements.activeFiltersChips.innerHTML = '';

    if (!hasStatus && !hasPriority && !hasSearch) {
      elements.activeFiltersBar.hidden = true;
      return;
    }

    elements.activeFiltersBar.hidden = false;

    if (hasStatus) {
      addChip(\`Status: \${state.filter.status}\`, () => {
        state.filter.status = 'ALL';
        elements.statusFilter.value = 'ALL';
        updateMetrics();
        renderTasks();
      });
    }

    if (hasPriority) {
      addChip(\`Priority: \${state.filter.priority}\`, () => {
        state.filter.priority = 'ALL';
        elements.priorityFilter.value = 'ALL';
        renderTasks();
      });
    }

    if (hasSearch) {
      addChip(\`Search: "\${state.filter.search}"\`, () => {
        state.filter.search = '';
        elements.searchInput.value = '';
        elements.searchClearBtn.hidden = true;
        renderTasks();
      });
    }
  }

  function addChip(text, onRemove) {
    const chip = document.createElement('span');
    chip.className = 'filter-chip';
    chip.innerHTML = \`\${escapeHtml(text)} <button type="button" class="filter-chip-remove" aria-label="Remove filter">&times;</button>\`;
    chip.querySelector('.filter-chip-remove').addEventListener('click', onRemove);
    elements.activeFiltersChips.appendChild(chip);
  }

  // ==========================================================================
  // Modal Handlers (Create, Edit, Delete)
  // ==========================================================================

  function openCreateModal() {
    state.editingTaskId = null;
    elements.modalTitle.textContent = 'Create New Task';
    elements.modalSubmitBtnText.textContent = 'Create Task';
    elements.taskIdInput.value = '';
    elements.taskTitleInput.value = '';
    elements.taskPriorityInput.value = 'Medium';
    elements.taskStatusInput.value = 'Pending';
    elements.titleValidationMsg.textContent = '';
    elements.titleCharCount.textContent = '0/200';
    elements.taskTitleInput.classList.remove('is-invalid');

    elements.taskModalOverlay.hidden = false;
    elements.taskTitleInput.focus();
  }

  function openEditModal(task) {
    state.editingTaskId = task.id;
    elements.modalTitle.textContent = 'Edit Task';
    elements.modalSubmitBtnText.textContent = 'Save Changes';
    elements.taskIdInput.value = task.id;
    elements.taskTitleInput.value = task.title;
    elements.taskPriorityInput.value = task.priority || 'Medium';
    elements.taskStatusInput.value = task.status || 'Pending';
    elements.titleValidationMsg.textContent = '';
    elements.titleCharCount.textContent = \`\${task.title.length}/200\`;
    elements.taskTitleInput.classList.remove('is-invalid');

    elements.taskModalOverlay.hidden = false;
    elements.taskTitleInput.focus();
  }

  function closeTaskModal() {
    elements.taskModalOverlay.hidden = true;
    state.editingTaskId = null;
  }

  function openDeleteModal(task) {
    state.deletingTaskId = task.id;
    elements.deleteTaskTitlePreview.textContent = \`"\${task.title}"\`;
    elements.deleteModalOverlay.hidden = false;
    elements.deleteCancelBtn.focus();
  }

  function closeDeleteModal() {
    elements.deleteModalOverlay.hidden = true;
    state.deletingTaskId = null;
  }

  // ==========================================================================
  // Form Submission & Mutation Actions
  // ==========================================================================

  async function handleTaskFormSubmit(e) {
    e.preventDefault();

    const title = elements.taskTitleInput.value.trim();
    const priority = elements.taskPriorityInput.value;
    const status = elements.taskStatusInput.value;

    // Client-side validation
    if (!title) {
      elements.titleValidationMsg.textContent = 'Task title is required.';
      elements.taskTitleInput.focus();
      return;
    }
    if (title.length > 200) {
      elements.titleValidationMsg.textContent = 'Task title cannot exceed 200 characters.';
      elements.taskTitleInput.focus();
      return;
    }
    elements.titleValidationMsg.textContent = '';

    // Set UI loading state
    elements.modalSubmitBtn.disabled = true;
    elements.modalBtnSpinner.hidden = false;

    try {
      if (state.editingTaskId) {
        // Edit Task
        const updated = await updateTaskInAPI(state.editingTaskId, {
          title,
          priority,
          status
        });

        // Update local state
        const index = state.tasks.findIndex(t => t.id === state.editingTaskId);
        if (index !== -1) {
          state.tasks[index] = updated.task || updated;
        }

        showToast('Task updated successfully!', 'success');
      } else {
        // Create Task
        const created = await createTaskInAPI({
          title,
          priority,
          status
        });

        const newTask = created.task || created;
        state.tasks.unshift(newTask);

        showToast('Task created successfully!', 'success');
      }

      closeTaskModal();
      updateMetrics();
      renderTasks();
    } catch (err) {
      showToast(\`Error: \${err.message}\`, 'error');
    } finally {
      elements.modalSubmitBtn.disabled = false;
      elements.modalBtnSpinner.hidden = true;
    }
  }

  async function handleDeleteConfirm() {
    if (!state.deletingTaskId) return;

    elements.deleteConfirmBtn.disabled = true;
    elements.deleteBtnSpinner.hidden = false;

    try {
      await deleteTaskInAPI(state.deletingTaskId);

      // Remove from local state
      state.tasks = state.tasks.filter(t => t.id !== state.deletingTaskId);

      showToast('Task deleted successfully.', 'info');
      closeDeleteModal();
      updateMetrics();
      renderTasks();
    } catch (err) {
      showToast(\`Delete failed: \${err.message}\`, 'error');
    } finally {
      elements.deleteConfirmBtn.disabled = false;
      elements.deleteBtnSpinner.hidden = true;
    }
  }

  async function handleQuickStatusChange(task, newStatus) {
    if (task.status === newStatus) return;

    try {
      const updated = await updateTaskInAPI(task.id, {
        title: task.title,
        priority: task.priority,
        status: newStatus
      });

      const updatedTask = updated.task || updated;
      const index = state.tasks.findIndex(t => t.id === task.id);
      if (index !== -1) {
        state.tasks[index] = updatedTask;
      }

      updateMetrics();
      renderTasks();
      showToast(\`Status updated to "\${newStatus}"\`, 'success');
    } catch (err) {
      showToast(\`Failed to update status: \${err.message}\`, 'error');
      renderTasks(); // Revert select to current state
    }
  }

  function resetFilters() {
    state.filter.status = 'ALL';
    state.filter.priority = 'ALL';
    state.filter.search = '';
    state.filter.sort = 'newest';

    elements.statusFilter.value = 'ALL';
    elements.priorityFilter.value = 'ALL';
    elements.searchInput.value = '';
    elements.sortOrder.value = 'newest';
    elements.searchClearBtn.hidden = true;

    updateMetrics();
    renderTasks();
  }

  // ==========================================================================
  // Helper & UI Utilities
  // ==========================================================================

  function showLoading(show) {
    elements.loadingState.hidden = !show;
    elements.loadingState.style.display = show ? 'flex' : 'none';
    if (show) {
      elements.tasksGrid.innerHTML = '';
      elements.emptyState.hidden = true;
      elements.emptyState.style.display = 'none';
    }
  }

  function showError(title, msg) {
    elements.errorTitle.textContent = title;
    elements.errorMessage.textContent = msg;
    elements.errorBanner.hidden = false;
    elements.errorBanner.style.display = 'flex';
  }

  function hideError() {
    elements.errorBanner.hidden = true;
    elements.errorBanner.style.display = 'none';
  }

  function setBackendOnline(online) {
    if (online) {
      elements.statusDot.className = 'status-dot status-online';
      elements.statusLabel.textContent = 'Cloudflare KV Online';
      elements.backendStatus.title = 'Connected to Cloudflare Workers & Workers KV';
    } else {
      elements.statusDot.className = 'status-dot status-offline';
      elements.statusLabel.textContent = 'Backend Offline';
      elements.backendStatus.title = 'Unable to reach Cloudflare Workers backend';
    }
  }

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = \`toast toast-\${type}\`;
    
    const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';

    toast.innerHTML = \`
      <span class="toast-icon" aria-hidden="true">\${icon}</span>
      <span class="toast-message">\${escapeHtml(message)}</span>
    \`;

    elements.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      setTimeout(() => {
        if (toast.parentNode) {
          toast.parentNode.removeChild(toast);
        }
      }, 200);
    }, 3500);
  }

  function formatDate(isoString) {
    if (!isoString) return 'Just now';
    try {
      const date = new Date(isoString);
      if (isNaN(date.getTime())) return isoString;
      return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      }).format(date);
    } catch {
      return isoString;
    }
  }

  function slugify(text) {
    return (text || '').toLowerCase().replace(/\\s+/g, '-');
  }

  function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ==========================================================================
  // Event Listeners Binding
  // ==========================================================================

  function bindEvents() {
    // Toolbar search & clear
    elements.searchInput.addEventListener('input', (e) => {
      state.filter.search = e.target.value;
      elements.searchClearBtn.hidden = !e.target.value;
      renderTasks();
    });

    elements.searchClearBtn.addEventListener('click', () => {
      elements.searchInput.value = '';
      state.filter.search = '';
      elements.searchClearBtn.hidden = true;
      elements.searchInput.focus();
      renderTasks();
    });

    // Filters and sort
    elements.statusFilter.addEventListener('change', (e) => {
      state.filter.status = e.target.value;
      updateMetrics();
      renderTasks();
    });

    elements.priorityFilter.addEventListener('change', (e) => {
      state.filter.priority = e.target.value;
      renderTasks();
    });

    elements.sortOrder.addEventListener('change', (e) => {
      state.filter.sort = e.target.value;
      renderTasks();
    });

    elements.refreshTasksBtn.addEventListener('click', () => {
      loadTasks();
    });

    elements.resetFiltersBtn.addEventListener('click', () => {
      resetFilters();
    });

    elements.errorRetryBtn.addEventListener('click', () => {
      loadTasks();
    });

    // Metric cards quick filter clicks
    elements.metricCardTotal.addEventListener('click', () => {
      state.filter.status = 'ALL';
      elements.statusFilter.value = 'ALL';
      updateMetrics();
      renderTasks();
    });

    elements.metricCardPending.addEventListener('click', () => {
      state.filter.status = 'Pending';
      elements.statusFilter.value = 'Pending';
      updateMetrics();
      renderTasks();
    });

    elements.metricCardProgress.addEventListener('click', () => {
      state.filter.status = 'In Progress';
      elements.statusFilter.value = 'In Progress';
      updateMetrics();
      renderTasks();
    });

    elements.metricCardCompleted.addEventListener('click', () => {
      state.filter.status = 'Completed';
      elements.statusFilter.value = 'Completed';
      updateMetrics();
      renderTasks();
    });

    // Modals open / close
    elements.openCreateModalBtn.addEventListener('click', openCreateModal);
    elements.modalCloseBtn.addEventListener('click', closeTaskModal);
    elements.modalCancelBtn.addEventListener('click', closeTaskModal);
    elements.deleteModalCloseBtn.addEventListener('click', closeDeleteModal);
    elements.deleteCancelBtn.addEventListener('click', closeDeleteModal);

    // Form inputs live counter
    elements.taskTitleInput.addEventListener('input', (e) => {
      const len = e.target.value.length;
      elements.titleCharCount.textContent = \`\${len}/200\`;
      if (len > 0) elements.titleValidationMsg.textContent = '';
    });

    // Form submission
    elements.taskForm.addEventListener('submit', handleTaskFormSubmit);
    elements.deleteConfirmBtn.addEventListener('click', handleDeleteConfirm);

    // Close on Escape or Backdrop click
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!elements.taskModalOverlay.hidden) closeTaskModal();
        if (!elements.deleteModalOverlay.hidden) closeDeleteModal();
      }
    });

    elements.taskModalOverlay.addEventListener('click', (e) => {
      if (e.target === elements.taskModalOverlay) closeTaskModal();
    });

    elements.deleteModalOverlay.addEventListener('click', (e) => {
      if (e.target === elements.deleteModalOverlay) closeDeleteModal();
    });
  }

  // ==========================================================================
  // Initialization
  // ==========================================================================

  function init() {
    bindEvents();
    loadTasks();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
`;
