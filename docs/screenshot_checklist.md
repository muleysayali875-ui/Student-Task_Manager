# Assignment Submission Screenshot Checklist

This checklist details all the visual evidence required for the **Student Task Management IaC Assignment**. 

---

## Part 1: Local Pre-Deployment Evidence (Can Be Captured Immediately)

These screenshots can be captured from your local terminal and development environment:

- [ ] **Screenshot 1: Test Suite Success (`npm test`)**
  - **Action**: Run `npm test` in the terminal.
  - **Expected Content**: Output showing all 27 tests passing (`pass 27`, `fail 0`).
  - **Save As**: `screenshots/01_npm_test_passed.png`

- [ ] **Screenshot 2: Terraform Formatting Check**
  - **Action**: Run `terraform fmt -check -recursive terraform/` in PowerShell.
  - **Expected Content**: Zero formatting warnings/errors (clean exit).
  - **Save As**: `screenshots/02_terraform_fmt_check.png`

- [ ] **Screenshot 3: Terraform Validation**
  - **Action**: Run `terraform -chdir=terraform validate` in PowerShell.
  - **Expected Content**: `Success! The configuration is valid.`
  - **Save As**: `screenshots/03_terraform_validate_success.png`

- [ ] **Screenshot 4: Project Structure**
  - **Action**: Open the project folder in VS Code / Antigravity IDE and expand `application/`, `terraform/`, and `.github/workflows/`.
  - **Expected Content**: Clean directory tree displaying all core files.
  - **Save As**: `screenshots/04_directory_structure.png`

---

## Part 2: GitHub Repository & Actions Evidence (After You Push)

These screenshots are captured from your GitHub repository (`https://github.com/muleysayali875-ui/Student_Task_Manager`):

- [ ] **Screenshot 5: GitHub Actions Workflow Run**
  - **Action**: Navigate to the **Actions** tab of the GitHub repository.
  - **Expected Content**: Green checkmark showing the `Student Task Manager CI/CD` workflow running `application-tests` and `terraform-validation`.
  - **Save As**: `screenshots/05_github_actions_ci_success.png`

- [ ] **Screenshot 6: GitHub Actions Secrets Configuration**
  - **Action**: Navigate to **Settings > Secrets and variables > Actions**.
  - **Expected Content**: Display of repository secrets list showing `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (values hidden by GitHub).
  - **Save As**: `screenshots/06_github_secrets_configured.png`

---

## Part 3: Cloudflare Dashboard Evidence (After Authorized Deployment)

These screenshots are captured from the Cloudflare Web Dashboard:

- [ ] **Screenshot 7: Cloudflare Workers Dashboard**
  - **Action**: Navigate to **Workers & Pages > Overview**.
  - **Expected Content**: The `student-task-manager-worker` listed as active with its `*.workers.dev` URL.
  - **Save As**: `screenshots/07_cloudflare_worker_overview.png`

- [ ] **Screenshot 8: Workers KV Namespace**
  - **Action**: Navigate to **Workers & Pages > KV**.
  - **Expected Content**: The namespace `student_task_manager_kv` showing active storage and keys.
  - **Save As**: `screenshots/08_cloudflare_kv_namespace.png`

- [ ] **Screenshot 9: Worker KV Binding Settings**
  - **Action**: Click on `student-task-manager-worker` > **Settings > Variables & KV Bindings**.
  - **Expected Content**: The binding `TASKS_KV` linked to `student_task_manager_kv`.
  - **Save As**: `screenshots/09_worker_kv_binding.png`

---

## Part 4: Live Application Evidence (After Authorized Deployment)

These screenshots are captured from your browser interacting with the live deployed worker URL:

- [ ] **Screenshot 10: Live Dashboard Overview**
  - **Action**: Visit `https://student-task-manager.muleysayali875.workers.dev`.
  - **Expected Content**: The dark-mode dashboard with "Online" status indicator and metrics cards (Total, Pending, In Progress, Completed).
  - **Save As**: `screenshots/10_live_dashboard.png`

- [ ] **Screenshot 11: Task Creation Modal & Active Tasks**
  - **Action**: Click "Add Task", fill in an academic task (e.g. "Complete Cloud Infrastructure Report", Priority: High), and save.
  - **Expected Content**: The task card displayed in the grid with high-priority badge and pending status.
  - **Save As**: `screenshots/11_task_created_live.png`

- [ ] **Screenshot 12: REST API Response in Browser/Postman**
  - **Action**: Navigate directly to `https://student-task-manager.muleysayali875.workers.dev/api/tasks` in browser or curl.
  - **Expected Content**: Formatted JSON array containing the task objects.
  - **Save As**: `screenshots/12_rest_api_json_response.png`
