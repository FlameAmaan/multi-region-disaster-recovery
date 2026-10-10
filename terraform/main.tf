resource "azurerm_resource_group" "primary" {
  name     = "rg-dr-primary-indiasouthcentral"
  location = var.location_primary

  tags = {
    project = "multi-region-disaster-recovery"
    role    = "primary"
  }
}

resource "azurerm_resource_group" "secondary" {
  name     = "rg-dr-secondary-centralindia"
  location = var.location_secondary

  tags = {
    project = "multi-region-disaster-recovery"
    role    = "secondary"
  }
}

resource "azurerm_virtual_network" "primary" {
  name                = "vnet-dr-primary"
  address_space       = ["10.10.0.0/16"]
  location            = azurerm_resource_group.primary.location
  resource_group_name = azurerm_resource_group.primary.name

  tags = {
    project = "multi-region-disaster-recovery"
    role    = "primary"
  }
}

resource "azurerm_subnet" "primary" {
  name                 = "subnet-web-primary"
  resource_group_name  = azurerm_resource_group.primary.name
  virtual_network_name = azurerm_virtual_network.primary.name
  address_prefixes     = ["10.10.1.0/24"]
}

resource "azurerm_virtual_network" "secondary" {
  name                = "vnet-dr-secondary"
  address_space       = ["10.20.0.0/16"]
  location            = azurerm_resource_group.secondary.location
  resource_group_name = azurerm_resource_group.secondary.name

  tags = {
    project = "multi-region-disaster-recovery"
    role    = "secondary"
  }
}

resource "azurerm_subnet" "secondary" {
  name                 = "subnet-web-secondary"
  resource_group_name  = azurerm_resource_group.secondary.name
  virtual_network_name = azurerm_virtual_network.secondary.name
  address_prefixes     = ["10.20.1.0/24"]
}

