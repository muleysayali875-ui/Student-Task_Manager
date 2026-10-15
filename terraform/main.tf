# Cloudflare Workers KV Namespace for persistent task storage
resource "cloudflare_workers_kv_namespace" "task_store" {
  account_id = var.cloudflare_account_id
  title      = var.kv_namespace_title
}

locals {
  # Deterministically resolve the worker script path from the module directory
  resolved_worker_script_path = startswith(var.worker_script_path, "/") || can(regex("^[A-Za-z]:", var.worker_script_path)) ? var.worker_script_path : "${path.module}/${var.worker_script_path}"
}

# Cloudflare Worker script and Worker-to-KV binding
resource "cloudflare_workers_script" "task_worker" {
  account_id         = var.cloudflare_account_id
  script_name        = var.worker_name
  main_module        = basename(var.worker_script_path)
  compatibility_date = var.compatibility_date

  # Loads worker script from application/worker.js if present (Stage 3),
  # or provides a fallback HTTP 503 response until implementation is deployed.
  content = fileexists(local.resolved_worker_script_path) ? file(local.resolved_worker_script_path) : <<-EOT
    export default {
      async fetch(request, env, ctx) {
        return new Response("Student Task Manager API - Implementation Pending (Stage 3)", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" }
        });
      }
    };
  EOT

  # Binding connecting the Worker runtime to the Workers KV namespace
  bindings = [
    {
      name         = var.kv_binding_name
      type         = "kv_namespace"
      namespace_id = cloudflare_workers_kv_namespace.task_store.id
    }
  ]
}

# Expose the Worker on the account's workers.dev subdomain route to serve the application
resource "cloudflare_workers_script_subdomain" "task_worker_subdomain" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_workers_script.task_worker.script_name
  enabled     = true
}
