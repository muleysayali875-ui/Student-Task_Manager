variable "cloudflare_api_token" {
  type        = string
  description = "Cloudflare API token with permissions for Workers and Workers KV. Can also be supplied via CLOUDFLARE_API_TOKEN environment variable."
  sensitive   = true
  default     = null
}

variable "cloudflare_account_id" {
  type        = string
  description = "The Cloudflare account ID where the Worker and KV namespace will be provisioned."
}

variable "worker_name" {
  type        = string
  description = "The name of the Cloudflare Worker script."
  default     = "student-task-manager-worker"
}

variable "kv_namespace_title" {
  type        = string
  description = "The human-readable title of the Cloudflare Workers KV namespace for task storage."
  default     = "student_task_manager_kv"
}

variable "kv_binding_name" {
  type        = string
  description = "The environment variable binding name used inside the Worker code (e.g., env.TASKS_KV)."
  default     = "TASKS_KV"
}

variable "compatibility_date" {
  type        = string
  description = "The Cloudflare Workers runtime compatibility date (YYYY-MM-DD)."
  default     = "2024-01-01"
}

variable "worker_script_path" {
  type        = string
  description = "Relative path to the Worker JavaScript entry point file."
  default     = "../application/worker.js"
}
