output "frontend_bucket_name" {
  description = "Nome do bucket S3 para o frontend"
  value       = aws_s3_bucket.frontend.bucket
}

output "cloudfront_url" {
  description = "URL pública do CloudFront"
  value       = "https://${aws_cloudfront_distribution.frontend.domain_name}"
}

output "api_gateway_url" {
  description = "URL do endpoint da API"
  value       = "https://${aws_api_gateway_rest_api.api.id}.execute-api.${var.aws_region}.amazonaws.com/${aws_api_gateway_stage.dev.stage_name}"
}

output "user_pool_id" {
  description = "ID do Cognito User Pool"
  value       = aws_cognito_user_pool.main.id
}

output "orders_table_name" {
  description = "Nome da tabela DynamoDB de pedidos"
  value       = aws_dynamodb_table.orders.name
}

output "orders_queue_url" {
  description = "URL da fila SQS de pedidos"
  value       = aws_sqs_queue.orders.url
}
