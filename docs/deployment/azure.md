# Azure Deployment

There is no official one-click Azure deployment template in this repository yet.

Recommended approach:

1. Build and publish a Buttress container image.
2. Provision MongoDB and Redis (managed or self-hosted).
3. Deploy Buttress to Azure Container Apps, AKS, or App Service for Containers.
4. Configure runtime values from [Configuration](../getting-started/configuration.md).
5. Set `BUTTRESS_HOST_URL` to your public endpoint and enable TLS.

Use [Docker](../docker.md) as the runtime baseline.
