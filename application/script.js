/**
 * Student Task Manager - Frontend Controller
 * Integrates with Cloudflare Workers REST API & Workers KV backend.
 */

(function () {
  'use strict';

  // Configurable API base URL (defaults to relative root for same-origin Worker deployment)
  const API_BASE = (window.TASK_MANAGER_API_BASE || '').replace(/\/$/, '');

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
    const url = `${API_BASE}${endpoint}`;
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
        const errorMsg = (data && data.error) ? data.error : `HTTP Error ${response.status}: ${response.statusText}`;
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
    return await apiRequest(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: 'PUT',
      body: JSON.stringify(updatePayload)
    });
  }

  async function deleteTaskInAPI(taskId) {
    return await apiRequest(`/api/tasks/${encodeURIComponent(taskId)}`, {
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
    card.className = `task-card priority-${(task.priority || 'medium').toLowerCase()} status-${slugify(task.status)}`;
    card.setAttribute('role', 'listitem');
    card.setAttribute('data-id', task.id);

    const formattedDate = formatDate(task.createdAt);

    card.innerHTML = `
      <div class="task-card-header">
        <div class="task-badges">
          <span class="badge badge-priority-${(task.priority || 'medium').toLowerCase()}">
            ${escapeHtml(task.priority)}
          </span>
          <span class="badge badge-status-${slugify(task.status)}">
            ${escapeHtml(task.status)}
          </span>
        </div>
        <select class="quick-status-select" aria-label="Change status for ${escapeHtml(task.title)}" data-action="quick-status">
          <option value="Pending" ${task.status === 'Pending' ? 'selected' : ''}>Pending</option>
          <option value="In Progress" ${task.status === 'In Progress' ? 'selected' : ''}>In Progress</option>
          <option value="Completed" ${task.status === 'Completed' ? 'selected' : ''}>Completed</option>
        </select>
      </div>

      <h3 class="task-title">${escapeHtml(task.title)}</h3>

      <div class="task-meta">
        <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14" aria-hidden="true">
          <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clip-rule="evenodd" />
        </svg>
        <time datetime="${escapeHtml(task.createdAt)}">Created ${formattedDate}</time>
      </div>

      <div class="task-card-footer">
        <span class="task-id-text" style="font-size: 0.6875rem; color: var(--text-muted); font-family: monospace;">
          ID: ${escapeHtml(task.id ? task.id.substring(0, 8) : '')}...
        </span>
        <div class="task-actions">
          <button type="button" class="btn-action btn-action-edit" data-action="edit" title="Edit task" aria-label="Edit task ${escapeHtml(task.title)}">
            <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14" aria-hidden="true">
              <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
            </svg>
            Edit
          </button>
          <button type="button" class="btn-action btn-action-delete" data-action="delete" title="Delete task" aria-label="Delete task ${escapeHtml(task.title)}">
            <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14" aria-hidden="true">
              <path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd" />
            </svg>
            Delete
          </button>
        </div>
      </div>
    `;

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
      addChip(`Status: ${state.filter.status}`, () => {
        state.filter.status = 'ALL';
        elements.statusFilter.value = 'ALL';
        updateMetrics();
        renderTasks();
      });
    }

    if (hasPriority) {
      addChip(`Priority: ${state.filter.priority}`, () => {
        state.filter.priority = 'ALL';
        elements.priorityFilter.value = 'ALL';
        renderTasks();
      });
    }

    if (hasSearch) {
      addChip(`Search: "${state.filter.search}"`, () => {
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
    chip.innerHTML = `${escapeHtml(text)} <button type="button" class="filter-chip-remove" aria-label="Remove filter">&times;</button>`;
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
    elements.titleCharCount.textContent = `${task.title.length}/200`;
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
    elements.deleteTaskTitlePreview.textContent = `"${task.title}"`;
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
      showToast(`Error: ${err.message}`, 'error');
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
      showToast(`Delete failed: ${err.message}`, 'error');
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
      showToast(`Status updated to "${newStatus}"`, 'success');
    } catch (err) {
      showToast(`Failed to update status: ${err.message}`, 'error');
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
    toast.className = `toast toast-${type}`;
    
    const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';

    toast.innerHTML = `
      <span class="toast-icon" aria-hidden="true">${icon}</span>
      <span class="toast-message">${escapeHtml(message)}</span>
    `;

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
    return (text || '').toLowerCase().replace(/\s+/g, '-');
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
      elements.titleCharCount.textContent = `${len}/200`;
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
