variable "aws_region" {
  description = "Região AWS para o deploy da aplicação"
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Nome do projeto para recursos AWS"
  type        = string
  default     = "stadiumtickets"
}

variable "environment" {
  description = "Ambiente da infraestrutura"
  type        = string
  default     = "dev"
}

variable "frontend_bucket_name" {
  description = "Nome do bucket S3 para hospedar o frontend"
  type        = string
  default     = "stadium-tickets-frontend-demo"
}

variable "admin_email" {
  description = "E-mail de confirmação do SES"
  type        = string
  default     = "admin@example.com"
}
