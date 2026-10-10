variable "location_primary" {
  description = "Primary Azure region"
  type        = string
  default     = "indiasouthcentral"
}

variable "location_secondary" {
  description = "Disaster recovery Azure region"
  type        = string
  default     = "centralindia"
}

variable "vm_size_primary" {
  description = "VM size for the primary web server"
  type        = string
  default     = "Standard_B1ms"
}

variable "vm_size_secondary" {
  description = "VM size for the secondary web server"
  type        = string
  default     = "Standard_B2s_v2"
}