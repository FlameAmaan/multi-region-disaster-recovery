resource "azurerm_storage_account" "dr_logs" {
  name                     = "amaanmrdrlgs2026"
  resource_group_name      = azurerm_resource_group.primary.name
  location                 = azurerm_resource_group.primary.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  account_kind             = "StorageV2"

  https_traffic_only_enabled      = true
  min_tls_version                 = "TLS1_2"
  allow_nested_items_to_be_public = false
  shared_access_key_enabled       = true

  tags = {
    project = "multi-region-disaster-recovery"
    purpose = "dr-test-logs"
  }
}

resource "azurerm_storage_table" "dr_test_logs" {
  name               = "DRTestLogs"
  storage_account_id = azurerm_storage_account.dr_logs.id
}

output "dr_storage_account_name" {
  value = azurerm_storage_account.dr_logs.name
}

output "dr_storage_table_name" {
  value = azurerm_storage_table.dr_test_logs.name
}
