output "worker_name" {
  description = "The name of the configured Cloudflare Worker script."
  value       = cloudflare_workers_script.task_worker.script_name
}

output "kv_namespace_id" {
  description = "The unique identifier of the Cloudflare Workers KV namespace."
  value       = cloudflare_workers_kv_namespace.task_store.id
}

output "kv_namespace_title" {
  description = "The human-readable title of the Workers KV namespace."
  value       = cloudflare_workers_kv_namespace.task_store.title
}

output "kv_binding_name" {
  description = "The environment variable binding name used inside the Worker to access the KV store."
  value       = var.kv_binding_name
}

output "workers_dev_subdomain_enabled" {
  description = "Whether the Worker is published to the workers.dev subdomain route."
  value       = cloudflare_workers_script_subdomain.task_worker_subdomain.enabled
}
