# GCP Deployment

There is no official one-click GCP deployment in this repository yet.

Recommended approach:

1. Build and publish a Buttress container image.
2. Run MongoDB and Redis as managed services or dedicated workloads.
3. Deploy Buttress on Cloud Run or GKE.
4. Configure environment variables from [Configuration](../getting-started/configuration.md).
5. Terminate TLS at your load balancer and set `BUTTRESS_HOST_URL` accordingly.

Use [Docker](../docker.md) as the runtime baseline.
