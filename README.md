# Automated Deployment of a Serverless Student Task Management Application Using Terraform-Based Infrastructure as Code

A production-ready serverless academic productivity application built with **Cloudflare Workers** and **Workers KV**, provisioned declaratively using **HashiCorp Terraform**, and continuously verified with **GitHub Actions**.

- **Live Deployed Application:** `https://student-task-manager.muleysayali875.workers.dev`
- **Live REST API:** `https://student-task-manager.muleysayali875.workers.dev/api/tasks`

---

## 1. Project Overview & Features

The **Student Task Manager** provides a serverless task management dashboard tailored for students to track coursework, projects, and assignment deadlines. Both the single-page application client and the full REST API are delivered from Cloudflare's global edge network.

### Key Capabilities
- **Full Task Lifecycle (CRUD)**: Create, list, retrieve, update, and delete tasks.
- **Priority & Status Tracking**: Classify tasks by priority (`Low`, `Medium`, `High`) and workflow status (`Pending`, `In Progress`, `Completed`).
- **Real-Time Client Dashboard**: Search, filter by status or priority, sort chronologically, and view live metrics (Total, Pending, In Progress, Completed).
- **Persistent Edge Storage**: Backed by Cloudflare Workers KV using the `TASKS_KV` binding.
- **Single-Worker Self-Contained Hosting**: Serves the responsive SPA dashboard directly alongside `/api/tasks` endpoints.
- **Declarative IaC**: 100% reproducible deployment using HashiCorp Terraform (Cloudflare Provider v5.x).
- **Automated CI/CD**: Pull request testing, Terraform validation, and protected automated deployments via GitHub Actions.

---

## 2. Architecture & Data Flow

```text
[ Browser / Student Client ]
             │
             ▼ HTTPS (GET /, GET /api/tasks, POST /api/tasks, etc.)
┌────────────────────────────────────────────────────────┐
│ Cloudflare Edge Runtime                                │
│                                                        │
│  student-task-manager-worker                           │
│  ├── Static Asset Router (/, /style.css, /script.js)   │
│  └── REST API Router & Validator (/api/tasks/*)        │
│             │                                          │
│             ▼ env.TASKS_KV (Workers KV Binding)        │
│  ┌──────────────────────────────────────────────────┐  │
│  │ student_task_manager_kv Namespace                │  │
│  │ Keys: task:<UUID> -> JSON serialized Task Model │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

---

## 3. Technology Stack

- **Edge Runtime**: Cloudflare Workers (ES Modules format, Compatibility Date `2024-01-01`).
- **Data Persistence**: Cloudflare Workers KV (`TASKS_KV`).
- **Frontend**: Vanilla JavaScript (ES6+), Modern Semantic HTML5, Vanilla CSS3 (Custom Properties & Responsive Grid).
- **Infrastructure as Code**: HashiCorp Terraform (v1.5.0+, verified on v1.16.5) with Cloudflare Provider `~> 5.0`.
- **Testing**: Native Node.js test runner (`node:test`, `node:assert/strict`) with in-memory KV simulation.
- **CI/CD**: GitHub Actions (`.github/workflows/ci-cd.yml`).

---

## 4. REST API Reference

All API routes are served under `/api/tasks`. Responses use standard JSON formatting with CORS enabled.

| Method | Endpoint | Description | Request Body | Success Status | Error Statuses |
|---|---|---|---|---|---|
| `GET` | `/api/tasks` | List all tasks (newest first) | None | `200 OK` | `500` |
| `POST` | `/api/tasks` | Create a new task | `{ "title": "...", "priority": "High", "status": "Pending" }` | `201 Created` | `400` |
| `GET` | `/api/tasks/:id` | Get task by UUID | None | `200 OK` | `404` |
| `PUT` | `/api/tasks/:id` | Update an existing task | `{ "title": "...", "priority": "...", "status": "..." }` | `200 OK` | `400`, `404` |
| `DELETE` | `/api/tasks/:id` | Delete task by UUID | None | `200 OK` | `404` |

---

## 5. Local Setup & Automated Testing

### Prerequisites
- Node.js (v20 or v22)
- Terraform CLI (v1.5.0+)

### Running Tests Locally
The project uses Node.js's built-in test runner to execute the automated suite against an in-memory Workers KV mock:

```bash
# Run all 27 unit & integration tests
npm test

# Alternatively, invoke directly with node
node --test application/worker.test.js
```

### Local Runtime Limitation Notice
Running `npx wrangler dev --local` on certain Windows 11 host environments encounters an OS loader error (`ERROR_BAD_EXE_FORMAT` / `spawn EFTYPE` on `workerd.exe`). The test suite (`npm test`) provides 100% automated coverage for application routing, input validation, and KV persistence without requiring the local `workerd` daemon. Full runtime verification is executed directly on the Cloudflare Workers edge environment.

---

## 6. Terraform Infrastructure as Code

The Terraform configuration resides in `terraform/`:

```text
terraform/
├── providers.tf            # Provider definition (cloudflare ~> 5.0)
├── variables.tf            # Input variables (account ID, tokens, names)
├── main.tf                 # KV namespace, Worker script, and subdomain route
├── outputs.tf              # Provisioned resource identifiers and URLs
└── terraform.tfvars.example# Example input template with placeholders
```

### Terraform Lifecycle Commands

```bash
# 1. Format check
terraform fmt -check -recursive terraform/

# 2. Initialize provider plugins (offline validation mode)
terraform -chdir=terraform init -backend=false

# 3. Validate syntax and configuration
terraform -chdir=terraform validate

# 4. Initialize with remote provider download (when deploying)
terraform -chdir=terraform init

# 5. Review execution plan
terraform -chdir=terraform plan -out=tfplan

# 6. Apply deployment (creates Worker, KV namespace, and bindings)
terraform -chdir=terraform apply tfplan

# 7. Safe teardown when requested
terraform -chdir=terraform destroy
```

---

## 7. Cloudflare Configuration Guide

To deploy this project to your Cloudflare account, follow these steps:

### Step 1: Obtain Your Cloudflare Account ID
1. Log into your [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. In the right-hand sidebar of your **Account Home** or under **Workers & Pages > Overview**, locate and copy your **Account ID**.

### Step 2: Create a Scoped API Token
1. Go to **My Profile > API Tokens** (or navigate to `https://dash.cloudflare.com/profile/api-tokens`).
2. Click **Create Token** > select **Create Custom Token**.
3. Name your token (e.g., `student-task-manager-deploy`).
4. Configure the minimum required permissions:
   - `Account` | `Workers KV Storage` | `Edit`
   - `Account` | `Workers Scripts` | `Edit`
   - `Account` | `Account Settings` | `Read`
5. Under **Account Resources**, select **Include > All accounts** (or your specific account).
6. Click **Continue to summary** > **Create Token**, and copy the token value securely.

### Step 3: Configure Local Environment Variables
Export credentials into your terminal session without hardcoding them into files:

**PowerShell (Windows):**
```powershell
$env:CLOUDFLARE_API_TOKEN = "your-api-token-here"
$env:TF_VAR_cloudflare_api_token = "your-api-token-here"
$env:TF_VAR_cloudflare_account_id = "your-account-id-here"
```

**Bash / Zsh (Linux/macOS):**
```bash
export CLOUDFLARE_API_TOKEN="your-api-token-here"
export TF_VAR_cloudflare_api_token="your-api-token-here"
export TF_VAR_cloudflare_account_id="your-account-id-here"
```

---

## 8. GitHub Actions CI/CD Pipeline

The repository includes a GitHub Actions workflow in `.github/workflows/ci-cd.yml`:

- **Pull Requests**: Automatically runs the 27 unit tests and validates Terraform manifests.
- **Pushes to `master`**: Runs tests, validates manifests, and deploys to Cloudflare if repository secrets are set.

### Configuring GitHub Repository Secrets
1. Navigate to your repository on GitHub: `https://github.com/muleysayali875-ui/Student_Task_Manager`.
2. Go to **Settings > Secrets and variables > Actions**.
3. Click **New repository secret** and add:
   - `CLOUDFLARE_API_TOKEN`: Your Cloudflare API token.
   - `CLOUDFLARE_ACCOUNT_ID`: Your Cloudflare Account ID.

---

## 9. Security & Hygiene Notes

- **No Secrets in Git**: Sensitive credentials are never hardcoded. All tokens are passed via environment variables or GitHub Secrets.
- **Ignored Files**: `.gitignore` excludes local state (`*.tfstate`), variable definitions (`*.tfvars`), local runtime caches (`.wrangler/`), and diagnostic files.
- **State Protection**: Never commit Terraform state files to public repositories.

---

## 10. Submission Documents

- **Technical Report**: See [docs/assignment_report.md](file:///d:/Student_Task_Manager/Student_Task_Manager/docs/assignment_report.md) for the complete 10-section academic assignment report.
- **Screenshot Checklist**: See [docs/screenshot_checklist.md](file:///d:/Student_Task_Manager/Student_Task_Manager/docs/screenshot_checklist.md) for pre- and post-deployment visual evidence requirements.
