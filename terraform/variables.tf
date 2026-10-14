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
  default     = "Standard_B2ats_v2"
}
variable "ssh_public_key" {
  description = "SSH public key used to access the Linux VMs"
  type        = string
  default     = ""
}