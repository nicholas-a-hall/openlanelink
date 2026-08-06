# Lunar Lanes Helm Chart

This Helm chart deploys the Lunar Lanes bowling alley management system to a Kubernetes cluster.

## Prerequisites

- Kubernetes 1.19+
- Helm 3.0+
- Storage provisioner for Redis persistence (optional)
- Ingress controller (nginx, traefik, etc.) if using ingress

## Installation

### Quick Start

```bash
# Add the Helm chart repository (if published)
helm repo add lunar-lanes https://your-repo.example.com
helm repo update

# Install with default values
helm install my-lunar-lanes lunar-lanes/lunar-lanes

# Or install from local chart directory
helm install my-lunar-lanes ./lunar-lanes
```

### Install with Custom Values

```bash
helm install my-lunar-lanes lunar-lanes/lunar-lanes \
  --set backend.googleCalendar.apiKey="YOUR_API_KEY" \
  --set backend.googleCalendar.calendarId="YOUR_CALENDAR_ID" \
  --set ingress.hosts[0].host="bowling.example.com"
```

### Install with Values File

```bash
# Create custom-values.yaml
cat <<EOF > custom-values.yaml
backend:
  googleCalendar:
    apiKey: "your-api-key"
    calendarId: "your-calendar-id@group.calendar.google.com"
    serviceAccountJson: |
      {
        "type": "service_account",
        "project_id": "your-project",
        ...
      }

ingress:
  enabled: true
  hosts:
    - host: bowling.example.com
      paths:
        - path: /
          pathType: Prefix
          service: frontend
          port: 80
EOF

# Install with custom values
helm install my-lunar-lanes lunar-lanes/lunar-lanes -f custom-values.yaml
```

## Configuration

### Global Settings

| Parameter | Description | Default |
|-----------|-------------|---------|
| `global.timezone` | System timezone | `America/Chicago` |

### Redis Configuration

| Parameter | Description | Default |
|-----------|-------------|---------|
| `redis.enabled` | Enable Redis deployment | `true` |
| `redis.image.repository` | Redis image repository | `redis` |
| `redis.image.tag` | Redis image tag | `7-alpine` |
| `redis.persistence.enabled` | Enable persistence | `true` |
| `redis.persistence.size` | PVC size | `1Gi` |
| `redis.persistence.storageClass` | Storage class | `""` (default) |
| `redis.resources.requests.memory` | Memory request | `128Mi` |
| `redis.resources.limits.memory` | Memory limit | `256Mi` |

### Backend Configuration

| Parameter | Description | Default |
|-----------|-------------|---------|
| `backend.replicaCount` | Number of replicas | `1` |
| `backend.image.repository` | Backend image | `lunar-lanes/backend` |
| `backend.image.tag` | Backend image tag | `latest` |
| `backend.service.type` | Service type | `ClusterIP` |
| `backend.service.port` | Service port | `3001` |
| `backend.env.nodeEnv` | Node environment | `production` |
| `backend.env.gcalSyncInterval` | Calendar sync interval (ms) | `120000` |
| `backend.googleCalendar.apiKey` | Google Calendar API key | `""` |
| `backend.googleCalendar.calendarId` | Google Calendar ID | `""` |
| `backend.googleCalendar.serviceAccountJson` | Service account JSON | `""` |
| `backend.resources.requests.memory` | Memory request | `256Mi` |
| `backend.resources.limits.memory` | Memory limit | `512Mi` |

### Frontend Configuration

| Parameter | Description | Default |
|-----------|-------------|---------|
| `frontend.replicaCount` | Number of replicas | `1` |
| `frontend.image.repository` | Frontend image | `lunar-lanes/frontend` |
| `frontend.image.tag` | Frontend image tag | `latest` |
| `frontend.service.type` | Service type | `ClusterIP` |
| `frontend.service.port` | Service port | `80` |
| `frontend.resources.requests.memory` | Memory request | `128Mi` |
| `frontend.resources.limits.memory` | Memory limit | `256Mi` |

### Kiosk Configuration

| Parameter | Description | Default |
|-----------|-------------|---------|
| `kiosk.enabled` | Enable kiosk deployments | `true` |
| `kiosk.deployments` | List of kiosk instances | See values.yaml |
| `kiosk.image.repository` | Kiosk image | `lunar-lanes/kiosk` |
| `kiosk.image.tag` | Kiosk image tag | `latest` |
| `kiosk.resources.requests.memory` | Memory request | `128Mi` |
| `kiosk.resources.limits.memory` | Memory limit | `256Mi` |

### Ingress Configuration

| Parameter | Description | Default |
|-----------|-------------|---------|
| `ingress.enabled` | Enable ingress | `true` |
| `ingress.className` | Ingress class | `nginx` |
| `ingress.annotations` | Ingress annotations | See values.yaml |
| `ingress.hosts` | Ingress hosts | `lunar-lanes.local` |
| `ingress.tls` | TLS configuration | See values.yaml |

## Google Calendar Integration

### Option 1: Read-Only Access (API Key)

For read-only calendar access (viewing existing reservations):

```yaml
backend:
  googleCalendar:
    apiKey: "YOUR_API_KEY"
    calendarId: "your-calendar@group.calendar.google.com"
```

### Option 2: Full Access (Service Account)

For creating/updating reservations from the UI:

1. Create a Google Cloud service account
2. Download the JSON key file
3. Share your calendar with the service account email

```yaml
backend:
  googleCalendar:
    apiKey: "YOUR_API_KEY"  # Still needed for some operations
    calendarId: "your-calendar@group.calendar.google.com"
    serviceAccountJson: |
      {
        "type": "service_account",
        "project_id": "your-project-id",
        "private_key_id": "key-id",
        "private_key": "-----BEGIN PRIVATE KEY-----\n...",
        "client_email": "service-account@project.iam.gserviceaccount.com",
        "client_id": "123456789",
        "auth_uri": "https://accounts.google.com/o/oauth2/auth",
        "token_uri": "https://oauth2.googleapis.com/token",
        "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
        "client_x509_cert_url": "https://www.googleapis.com/robot/v1/metadata/x509/..."
      }
```

**Alternative: Using Kubernetes Secrets**

```bash
# Create secret from file
kubectl create secret generic gcal-service-account \
  --from-file=service-account.json=./path/to/service-account.json \
  -n lunar-lanes

# Then reference in values
backend:
  googleCalendar:
    serviceAccountJsonSecret: gcal-service-account
    serviceAccountJsonKey: service-account.json
```

## Accessing Services

### Via Ingress (Production)

Once deployed with ingress enabled:

- **Manager Dashboard:** https://your-domain.com/
- **Backend API:** https://your-domain.com/api
- **Kiosk Lanes 1-2:** https://your-domain.com/kiosk/lanes-1-2
- **Kiosk Lanes 3-4:** https://your-domain.com/kiosk/lanes-3-4
- **Kiosk Lanes 5-6:** https://your-domain.com/kiosk/lanes-5-6
- **Kiosk Lanes 7-8:** https://your-domain.com/kiosk/lanes-7-8

### Via Port Forwarding (Development)

```bash
# Manager dashboard
kubectl port-forward svc/my-lunar-lanes-frontend 8080:80
# Access at http://localhost:8080

# Backend API
kubectl port-forward svc/my-lunar-lanes-backend 3001:3001
# Access at http://localhost:3001

# Kiosk (Lanes 1-2)
kubectl port-forward svc/my-lunar-lanes-kiosk-lanes-1-2 8081:8081
# Access at http://localhost:8081
```

## Persistence

By default, Redis persistence is enabled with a 1Gi PersistentVolumeClaim. This ensures reservation data survives pod restarts.

### Disable Persistence (Not Recommended)

```yaml
redis:
  persistence:
    enabled: false
```

### Use Custom Storage Class

```yaml
redis:
  persistence:
    enabled: true
    storageClass: "fast-ssd"
    size: 5Gi
```

## Scaling

### Backend Scaling

```bash
# Scale backend replicas
helm upgrade my-lunar-lanes lunar-lanes/lunar-lanes \
  --set backend.replicaCount=3
```

### Enable Autoscaling

```yaml
autoscaling:
  enabled: true
  minReplicas: 1
  maxReplicas: 5
  targetCPUUtilizationPercentage: 80
```

## Upgrading

```bash
# Upgrade with new values
helm upgrade my-lunar-lanes lunar-lanes/lunar-lanes -f custom-values.yaml

# Upgrade with specific parameters
helm upgrade my-lunar-lanes lunar-lanes/lunar-lanes \
  --set backend.image.tag=v2.0.0
```

## Uninstalling

```bash
# Uninstall release
helm uninstall my-lunar-lanes

# If persistence was enabled, manually delete PVC
kubectl delete pvc data-my-lunar-lanes-redis-0
```

## Monitoring

### Health Checks

The backend includes health check endpoints:

- **Liveness:** `GET /health`
- **Readiness:** `GET /health`

### View Logs

```bash
# Backend logs
kubectl logs -l app.kubernetes.io/component=backend -f

# Frontend logs
kubectl logs -l app.kubernetes.io/component=frontend -f

# All pods
kubectl logs -l app.kubernetes.io/instance=my-lunar-lanes -f --all-containers
```

## Troubleshooting

### Pods Not Starting

```bash
# Check pod status
kubectl get pods -l app.kubernetes.io/instance=my-lunar-lanes

# Describe problematic pod
kubectl describe pod <pod-name>

# Check events
kubectl get events --sort-by=.metadata.creationTimestamp
```

### Redis Connection Issues

```bash
# Test Redis connection
kubectl exec -it <backend-pod-name> -- redis-cli -h my-lunar-lanes-redis ping

# Check Redis logs
kubectl logs -l app.kubernetes.io/component=redis
```

### WebSocket Connection Issues

Ensure ingress is configured for WebSocket support:

```yaml
ingress:
  annotations:
    nginx.ingress.kubernetes.io/websocket-services: "lunar-lanes-backend"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
```

### Google Calendar Not Syncing

```bash
# Check backend logs for errors
kubectl logs -l app.kubernetes.io/component=backend | grep -i gcal

# Verify secrets are set
kubectl get secret my-lunar-lanes-secrets -o yaml
```

## Security Considerations

### Production Checklist

- [ ] Use TLS/HTTPS (configure ingress.tls)
- [ ] Store Google Calendar credentials in Kubernetes secrets
- [ ] Use network policies to restrict pod communication
- [ ] Enable pod security policies
- [ ] Run containers as non-root user (default)
- [ ] Use read-only root filesystem where possible
- [ ] Regularly update images to patch vulnerabilities
- [ ] Backup Redis data regularly

### Network Policies

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: lunar-lanes-network-policy
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: lunar-lanes
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: lunar-lanes
  egress:
    - to:
        - podSelector:
            matchLabels:
              app.kubernetes.io/component: redis
```

## Advanced Configuration

### External Redis

To use an external Redis instance:

```yaml
redis:
  enabled: false
  externalUrl: "redis://external-redis.example.com:6379"
```

### Custom Kiosk Configuration

Add or modify kiosk deployments:

```yaml
kiosk:
  deployments:
    - name: lanes-1-4
      lanes: "1,2,3,4"
      port: 8081
    - name: lanes-5-8
      lanes: "5,6,7,8"
      port: 8082
```

### Resource Limits

Adjust resource limits for production:

```yaml
backend:
  resources:
    requests:
      memory: "512Mi"
      cpu: "500m"
    limits:
      memory: "1Gi"
      cpu: "1000m"

redis:
  resources:
    requests:
      memory: "256Mi"
      cpu: "200m"
    limits:
      memory: "512Mi"
      cpu: "500m"
```

## Support

For issues and questions:
- GitHub Issues: https://github.com/yourusername/lunar-lanes/issues
- Documentation: See USER_MANUAL.md and DEVELOPER_GUIDE.md

## License

See LICENSE file for details.
