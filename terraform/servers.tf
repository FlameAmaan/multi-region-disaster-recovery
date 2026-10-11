
resource "azurerm_network_security_group" "primary" {
  name                = "nsg-dr-primary"
  location            = azurerm_resource_group.primary.location
  resource_group_name = azurerm_resource_group.primary.name

  security_rule {
    name                       = "Allow-HTTP"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "80"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }
}

resource "azurerm_network_security_group" "secondary" {
  name                = "nsg-dr-secondary"
  location            = azurerm_resource_group.secondary.location
  resource_group_name = azurerm_resource_group.secondary.name

  security_rule {
    name                       = "Allow-HTTP"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "80"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }
}

resource "azurerm_subnet_network_security_group_association" "primary" {
  subnet_id                 = azurerm_subnet.primary.id
  network_security_group_id = azurerm_network_security_group.primary.id
}

resource "azurerm_subnet_network_security_group_association" "secondary" {
  subnet_id                 = azurerm_subnet.secondary.id
  network_security_group_id = azurerm_network_security_group.secondary.id
}

resource "azurerm_public_ip" "primary" {
  name                = "pip-dr-primary"
  location            = azurerm_resource_group.primary.location
  resource_group_name = azurerm_resource_group.primary.name
  allocation_method   = "Static"
  sku                 = "Standard"
  domain_name_label   = "amaan-dr-primary-2026"
}

resource "azurerm_public_ip" "secondary" {
  name                = "pip-dr-secondary"
  location            = azurerm_resource_group.secondary.location
  resource_group_name = azurerm_resource_group.secondary.name
  allocation_method   = "Static"
  sku                 = "Standard"
  domain_name_label   = "amaan-dr-secondary-2026"
}

resource "azurerm_network_interface" "primary" {
  name                = "nic-dr-primary"
  location            = azurerm_resource_group.primary.location
  resource_group_name = azurerm_resource_group.primary.name

  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.primary.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.primary.id
  }
}

resource "azurerm_network_interface" "secondary" {
  name                = "nic-dr-secondary"
  location            = azurerm_resource_group.secondary.location
  resource_group_name = azurerm_resource_group.secondary.name

  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.secondary.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.secondary.id
  }
}

resource "azurerm_linux_virtual_machine" "primary" {
  name                = "vm-dr-primary"
  resource_group_name = azurerm_resource_group.primary.name
  location            = azurerm_resource_group.primary.location
  size                = var.vm_size_primary
  admin_username      = "azureuser"
  network_interface_ids = [
    azurerm_network_interface.primary.id
  ]

  disable_password_authentication = true

  admin_ssh_key {
    username   = "azureuser"
    public_key = file(pathexpand("~/.ssh/id_rsa.pub"))
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Standard_LRS"
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-jammy"
    sku       = "22_04-lts-gen2"
    version   = "latest"
  }

  custom_data = base64encode(<<-EOF
    #!/bin/bash
    apt-get update
    apt-get install -y nginx
    echo '<h1>PRIMARY REGION</h1><p>India South Central</p>' > /var/www/html/index.html
    systemctl enable --now nginx
  EOF
  )

  tags = {
    project = "multi-region-disaster-recovery"
    role    = "primary"
  }
}

resource "azurerm_linux_virtual_machine" "secondary" {
  name                = "vm-dr-secondary"
  resource_group_name = azurerm_resource_group.secondary.name
  location            = azurerm_resource_group.secondary.location
  zone                = "3"
  size                = var.vm_size_secondary
  admin_username      = "azureuser"
  network_interface_ids = [
    azurerm_network_interface.secondary.id
  ]

  disable_password_authentication = true

  admin_ssh_key {
    username   = "azureuser"
    public_key = file(pathexpand("~/.ssh/id_rsa.pub"))
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Standard_LRS"
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-jammy"
    sku       = "22_04-lts-gen2"
    version   = "latest"
  }

  custom_data = base64encode(<<-EOF
    #!/bin/bash
    apt-get update
    apt-get install -y nginx
    echo '<h1>SECONDARY REGION</h1><p>Central India</p>' > /var/www/html/index.html
    systemctl enable --now nginx
  EOF
  )

  tags = {
    project = "multi-region-disaster-recovery"
    role    = "secondary"
  }
}
