terraform {
  required_version = ">= 1.5.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

# The Cloudflare provider can authenticate via the CLOUDFLARE_API_TOKEN environment variable
# or via the optional cloudflare_api_token variable.
provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
