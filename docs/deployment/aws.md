# AWS Deployment

There is no official one-click AWS deployment template in this repository yet.

Recommended approach:

1. Build and publish a Buttress container image.
2. Use DocumentDB/MongoDB-compatible deployment as required and Redis (for example ElastiCache).
3. Run Buttress on ECS/Fargate or EKS.
4. Configure environment variables from [Configuration](../getting-started/configuration.md).
5. Set `BUTTRESS_HOST_URL` to your public endpoint with TLS.

Use [Docker](../docker.md) as the runtime baseline.
