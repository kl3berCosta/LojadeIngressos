# Arquitetura em nuvem AWS para a loja de ingressos

## Padrão recomendado

A solução é organizada em camadas para atingir escalabilidade, segurança e alta disponibilidade.

### Camada de apresentação

- Amazon S3 para armazenamento do front-end estático
- Amazon CloudFront para entrega em CDN
- Amazon Route 53 para DNS e roteamento
- AWS WAF para proteção contra abuso e ataques

### Camada de autenticação

- Amazon Cognito para cadastro, login e autorização de usuários

### Camada de aplicação

- Amazon API Gateway para expor endpoints da loja
- AWS Lambda para processar compras e validações de inventário
- Amazon ECS / Fargate opcional para APIs mais complexas e com maior volume

### Camada de dados

- Amazon DynamoDB para armazenamento de pedidos, eventos e disponibilidade
- Amazon SQS para fila de eventos assíncronos
- Amazon SES para envio de e-mails de confirmação

### Monitoramento

- Amazon CloudWatch para métricas, logs e alarmes
- AWS X-Ray para rastreio de requisições e diagnósticos

## Fluxo de compra

1. Usuário acessa a loja pelo CloudFront.
2. O front-end envia requisições para a API Gateway.
3. A API valida o evento e a disponibilidade.
4. O pedido é salvo no DynamoDB.
5. Uma mensagem é enviada para SQS para processamento assíncrono.
6. O serviço de processamento confirma o pagamento e atualiza o estoque.
7. O cliente recebe confirmação por e-mail via SES.

## Recomendação de escala

- S3 + CloudFront para suportar picos de acesso sem aumentar carga no backend.
- Lambda em modo provisionado ou on-demand para escalar automaticamente.
- DynamoDB com throughput adequado para eventos e compras em alta demanda.
- SQS para desacoplar processamento de compra e evitar perda de disponibilidade.

## Prática de segurança

- uso de IAM com menor privilégio;
- criptografia em repouso para dados sensíveis;
- HTTPS obrigatório;
- WAF e CloudFront para reduzir ataques;
- logs centralizados no CloudWatch.

## Provisionamento com Terraform

A pasta `infra` contém uma base inicial em Terraform para provisionar os componentes principais da solução AWS:

- S3 + CloudFront para front-end
- Cognito para autenticação
- DynamoDB para pedidos
- SQS para processamento assíncrono
- API Gateway + Lambda para API de vendas
- SES para envio de e-mail

### Comandos

```bash
cd infra
terraform init
terraform plan
terraform apply
```

### Observações

- Ajuste o valor de `admin_email` para um endereço verificado no SES.
- Ajuste `frontend_bucket_name` para um nome globalmente único.
- Após o provisionamento, publique o conteúdo da pasta `frontend` no bucket S3 criado.

## Futuras evoluções

- pagamento com cartão via Stripe ou Mercado Pago
- autenticação com Cognito + MFA
- dashboard administrativo para gestão de eventos
- relatórios de vendas e assentos
- integração com Data Lake para analítica de comportamento
