resource "azurerm_traffic_manager_profile" "dr" {
  name                   = "tm-dr-amaan-web"
  resource_group_name    = azurerm_resource_group.primary.name
  traffic_routing_method = "Priority"

  dns_config {
    relative_name = "amaan-mrdr-2026"
    ttl           = 30
  }

  monitor_config {
    protocol                     = "HTTP"
    port                         = 80
    path                         = "/"
    interval_in_seconds          = 30
    timeout_in_seconds           = 9
    tolerated_number_of_failures = 3
  }

  tags = {
    project = "multi-region-disaster-recovery"
  }
}

resource "azurerm_traffic_manager_azure_endpoint" "primary" {
  name               = "primary-endpoint"
  profile_id         = azurerm_traffic_manager_profile.dr.id
  target_resource_id = azurerm_public_ip.primary.id
  priority           = 1
}

resource "azurerm_traffic_manager_azure_endpoint" "secondary" {
  name               = "secondary-endpoint"
  profile_id         = azurerm_traffic_manager_profile.dr.id
  target_resource_id = azurerm_public_ip.secondary.id
  priority           = 2
}