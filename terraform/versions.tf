
terraform {
  required_version = ">= 1.5.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }

  backend "azurerm" {
    resource_group_name  = "rg-dr-primary-indiasouthcentral"
    storage_account_name = "amaanmrdrlgs2026"
    container_name       = "terraform-state"
    key                  = "multi-region-disaster-recovery.tfstate"
    use_azuread_auth     = true
  }
}

provider "azurerm" {
  features {}
  resource_provider_registrations = "none"
}
