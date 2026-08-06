# Kubernetes Deployment Guide

This guide walks through deploying OpenLane Scheduler to a Kubernetes cluster using Helm.

---

## Prerequisites

### Required Tools

- Docker (for building images)
- kubectl (configured for your cluster)
- Helm 3.0+
- Access to a Kubernetes cluster (1.19+)
- Container registry (Docker Hub, GCR, ECR, etc.)

### Cluster Requirements

- **Storage:** Default storage class or custom StorageClass for Redis persistence
- **Ingress Controller:** nginx-ingress, traefik, or similar (optional but recommended)
- **Resources:** Minimum 2 CPU cores, 4GB RAM available

---

## Step 1: Build Docker Images

### Backend Image

```bash
# Navigate to backend directory
cd backend

# Build image
docker build -t YOUR_REGISTRY/openlanescheduler/backend:latest .

# Tag with version
docker tag YOUR_REGISTRY/openlanescheduler/backend:latest YOUR_REGISTRY/openlanescheduler/backend:v1.0.0

# Push to registry
docker push YOUR_REGISTRY/openlanescheduler/backend:latest
docker push YOUR_REGISTRY/openlanescheduler/backend:v1.0.0
```

### Frontend Image

```bash
# Navigate to frontend directory
cd frontend

# Build production bundle
npm run build

# Create Dockerfile if not exists
cat <<EOF > Dockerfile
FROM nginx:alpine
COPY dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
EOF

# Create nginx config
cat <<EOF > nginx.conf
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # Proxy API requests to backend
    location /api {
        proxy_pass http://BACKEND_SERVICE:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
    }

    # Proxy WebSocket requests
    location /socket.io {
        proxy_pass http://BACKEND_SERVICE:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOF

# Build and push
docker build -t YOUR_REGISTRY/openlanescheduler/frontend:latest .
docker tag YOUR_REGISTRY/openlanescheduler/frontend:latest YOUR_REGISTRY/openlanescheduler/frontend:v1.0.0
docker push YOUR_REGISTRY/openlanescheduler/frontend:latest
docker push YOUR_REGISTRY/openlanescheduler/frontend:v1.0.0
```

### Kiosk Image

```bash
# Navigate to kiosk directory
cd kiosk

# Build production bundle
npm run build

# Create Dockerfile (same as frontend)
cat <<EOF > Dockerfile
FROM nginx:alpine
COPY dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
EOF

# Create nginx config (same structure as frontend)
# ... (copy from above)

# Build and push
docker build -t YOUR_REGISTRY/openlanescheduler/kiosk:latest .
docker tag YOUR_REGISTRY/openlanescheduler/kiosk:latest YOUR_REGISTRY/openlanescheduler/kiosk:v1.0.0
docker push YOUR_REGISTRY/openlanescheduler/kiosk:latest
docker push YOUR_REGISTRY/openlanescheduler/kiosk:v1.0.0
```

---

## Step 2: Prepare Kubernetes Cluster

### Create Namespace

```bash
kubectl create namespace openlanescheduler
kubectl config set-context --current --namespace=openlanescheduler
```

### Install Ingress Controller (if not already installed)

**Using nginx-ingress:**

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update
helm install nginx-ingress ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace \
  --set controller.service.type=LoadBalancer
```

**Verify ingress is running:**

```bash
kubectl get pods -n ingress-nginx
kubectl get svc -n ingress-nginx
```

### Install cert-manager (Optional, for TLS)

```bash
helm repo add jetstack https://charts.jetstack.io
helm repo update
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --set installCRDs=true

# Create Let's Encrypt ClusterIssuer
cat <<EOF | kubectl apply -f -
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: your-email@example.com
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
    - http01:
        ingress:
          class: nginx
EOF
```

---

## Step 3: Configure Helm Values

### Create Custom Values File

```bash
cat <<EOF > production-values.yaml
# Global settings
global:
  timezone: "America/Chicago"

# Backend configuration
backend:
  image:
    repository: YOUR_REGISTRY/openlanescheduler/backend
    tag: v1.0.0
    pullPolicy: Always

  env:
    nodeEnv: production
    gcalSyncInterval: "120000"

  googleCalendar:
    apiKey: "YOUR_GOOGLE_CALENDAR_API_KEY"
    calendarId: "your-calendar@group.calendar.google.com"
    serviceAccountJson: |
      {
        "type": "service_account",
        "project_id": "your-project",
        "private_key_id": "...",
        "private_key": "-----BEGIN PRIVATE KEY-----\n...",
        "client_email": "service-account@project.iam.gserviceaccount.com",
        ...
      }

  resources:
    requests:
      memory: "512Mi"
      cpu: "500m"
    limits:
      memory: "1Gi"
      cpu: "1000m"

# Frontend configuration
frontend:
  image:
    repository: YOUR_REGISTRY/openlanescheduler/frontend
    tag: v1.0.0
    pullPolicy: Always

  resources:
    requests:
      memory: "256Mi"
      cpu: "200m"
    limits:
      memory: "512Mi"
      cpu: "500m"

# Kiosk configuration
kiosk:
  enabled: true
  image:
    repository: YOUR_REGISTRY/openlanescheduler/kiosk
    tag: v1.0.0
    pullPolicy: Always

  deployments:
    - name: lanes-1-2
      lanes: "1,2"
      port: 8081
    - name: lanes-3-4
      lanes: "3,4"
      port: 8082
    - name: lanes-5-6
      lanes: "5,6"
      port: 8083
    - name: lanes-7-8
      lanes: "7,8"
      port: 8084

# Redis configuration
redis:
  enabled: true
  persistence:
    enabled: true
    size: 5Gi
    storageClass: ""  # Use default or specify: "fast-ssd"

  resources:
    requests:
      memory: "256Mi"
      cpu: "200m"
    limits:
      memory: "512Mi"
      cpu: "500m"

# Ingress configuration
ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    nginx.ingress.kubernetes.io/websocket-services: "openlanescheduler-backend"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"

  hosts:
    - host: bowling.example.com
      paths:
        - path: /api
          pathType: Prefix
          service: backend
          port: 3001
        - path: /socket.io
          pathType: Prefix
          service: backend
          port: 3001
        - path: /kiosk/lanes-1-2
          pathType: Prefix
          service: kiosk-lanes-1-2
          port: 8081
        - path: /kiosk/lanes-3-4
          pathType: Prefix
          service: kiosk-lanes-3-4
          port: 8082
        - path: /kiosk/lanes-5-6
          pathType: Prefix
          service: kiosk-lanes-5-6
          port: 8083
        - path: /kiosk/lanes-7-8
          pathType: Prefix
          service: kiosk-lanes-7-8
          port: 8084
        - path: /
          pathType: Prefix
          service: frontend
          port: 80

  tls:
    - secretName: openlanescheduler-tls
      hosts:
        - bowling.example.com

# Security
podSecurityContext:
  fsGroup: 1000

securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  capabilities:
    drop:
      - ALL
  readOnlyRootFilesystem: false
EOF
```

---

## Step 4: Deploy with Helm

### Install Chart

```bash
# From local chart directory
helm install openlanescheduler ./helm/openlanescheduler \
  -f production-values.yaml \
  --namespace openlanescheduler

# Or if chart is published
helm repo add openlanescheduler https://your-chart-repo.example.com
helm install openlanescheduler openlanescheduler/openlanescheduler \
  -f production-values.yaml \
  --namespace openlanescheduler
```

### Verify Deployment

```bash
# Check all pods are running
kubectl get pods -n openlanescheduler

# Expected output:
# NAME                                        READY   STATUS    RESTARTS   AGE
# openlanescheduler-backend-xxx                     1/1     Running   0          2m
# openlanescheduler-frontend-xxx                    1/1     Running   0          2m
# openlanescheduler-kiosk-lanes-1-2-xxx             1/1     Running   0          2m
# openlanescheduler-kiosk-lanes-3-4-xxx             1/1     Running   0          2m
# openlanescheduler-kiosk-lanes-5-6-xxx             1/1     Running   0          2m
# openlanescheduler-kiosk-lanes-7-8-xxx             1/1     Running   0          2m
# openlanescheduler-redis-0                         1/1     Running   0          2m

# Check services
kubectl get svc -n openlanescheduler

# Check ingress
kubectl get ingress -n openlanescheduler

# View logs
kubectl logs -l app.kubernetes.io/component=backend -n openlanescheduler -f
```

---

## Step 5: Configure DNS

Point your domain to the ingress controller's external IP:

```bash
# Get ingress IP/hostname
kubectl get svc -n ingress-nginx nginx-ingress-ingress-nginx-controller

# Create DNS A record
# bowling.example.com -> <EXTERNAL-IP>
```

---

## Step 6: Verify Deployment

### Test Manager Dashboard

```bash
# Via browser
open https://bowling.example.com

# Or curl
curl -I https://bowling.example.com
```

### Test Backend API

```bash
curl https://bowling.example.com/api/health
```

### Test Kiosk Displays

```bash
open https://bowling.example.com/kiosk/lanes-1-2
```

### Test WebSocket Connection

```javascript
// In browser console on manager dashboard
console.log('WebSocket:', window.socket.connected ? 'Connected' : 'Disconnected');
```

---

## Common Deployment Scenarios

### Development/Testing Cluster

```yaml
# dev-values.yaml
backend:
  image:
    tag: dev
    pullPolicy: Always
  replicaCount: 1

redis:
  persistence:
    enabled: false  # Use in-memory for dev

ingress:
  enabled: false  # Use port-forwarding instead

resources:
  requests:
    memory: "128Mi"
    cpu: "100m"
  limits:
    memory: "256Mi"
    cpu: "200m"
```

### Production with High Availability

```yaml
# ha-values.yaml
backend:
  replicaCount: 3
  resources:
    requests:
      memory: "1Gi"
      cpu: "1000m"
    limits:
      memory: "2Gi"
      cpu: "2000m"

redis:
  persistence:
    enabled: true
    size: 20Gi
    storageClass: "fast-ssd"
  resources:
    requests:
      memory: "512Mi"
      cpu: "500m"
    limits:
      memory: "1Gi"
      cpu: "1000m"

autoscaling:
  enabled: true
  minReplicas: 2
  maxReplicas: 10
  targetCPUUtilizationPercentage: 70
```

---

## Maintenance Operations

### Update Application

```bash
# Build new images with new tag
docker build -t YOUR_REGISTRY/openlanescheduler/backend:v1.1.0 .
docker push YOUR_REGISTRY/openlanescheduler/backend:v1.1.0

# Upgrade Helm release
helm upgrade openlanescheduler ./helm/openlanescheduler \
  --set backend.image.tag=v1.1.0 \
  -f production-values.yaml
```

### Scale Backend

```bash
# Via Helm
helm upgrade openlanescheduler ./helm/openlanescheduler \
  --set backend.replicaCount=5 \
  -f production-values.yaml

# Or directly with kubectl
kubectl scale deployment openlanescheduler-backend --replicas=5 -n openlanescheduler
```

### Backup Redis Data

```bash
# Create backup
kubectl exec -n openlanescheduler openlanescheduler-redis-0 -- redis-cli SAVE

# Copy backup file
kubectl cp openlanescheduler/openlanescheduler-redis-0:/data/dump.rdb ./backup-$(date +%Y%m%d).rdb

# Restore from backup
kubectl cp ./backup-20260215.rdb openlanescheduler/openlanescheduler-redis-0:/data/dump.rdb
kubectl delete pod openlanescheduler-redis-0 -n openlanescheduler  # Will restart with new data
```

### View Logs

```bash
# All backend logs
kubectl logs -l app.kubernetes.io/component=backend -n openlanescheduler --tail=100 -f

# Specific pod
kubectl logs openlanescheduler-backend-xxx -n openlanescheduler -f

# Previous pod instance (if crashed)
kubectl logs openlanescheduler-backend-xxx -n openlanescheduler -p
```

### Restart Services

```bash
# Restart backend
kubectl rollout restart deployment openlanescheduler-backend -n openlanescheduler

# Restart all deployments
kubectl rollout restart deployment -n openlanescheduler
```

---

## Troubleshooting

### Pods Not Starting

```bash
# Describe pod
kubectl describe pod <pod-name> -n openlanescheduler

# Common issues:
# - Image pull errors: Check registry credentials
# - Resource limits: Check cluster capacity
# - Storage issues: Check PVC status

# Check PVC
kubectl get pvc -n openlanescheduler
kubectl describe pvc data-openlanescheduler-redis-0 -n openlanescheduler
```

### Backend Can't Connect to Redis

```bash
# Test Redis connectivity
kubectl exec -n openlanescheduler <backend-pod> -- redis-cli -h openlanescheduler-redis ping

# Should return: PONG
```

### Ingress Not Working

```bash
# Check ingress status
kubectl describe ingress openlanescheduler -n openlanescheduler

# Check ingress controller logs
kubectl logs -n ingress-nginx -l app.kubernetes.io/component=controller -f

# Verify DNS
nslookup bowling.example.com

# Test without ingress
kubectl port-forward svc/openlanescheduler-frontend 8080:80 -n openlanescheduler
```

### Certificate Issues

```bash
# Check cert-manager status
kubectl get certificate -n openlanescheduler
kubectl describe certificate openlanescheduler-tls -n openlanescheduler

# Check certificate request
kubectl get certificaterequest -n openlanescheduler

# Force renewal
kubectl delete certificate openlanescheduler-tls -n openlanescheduler
# Will auto-recreate
```

---

## Monitoring & Observability

### Prometheus Metrics

Add Prometheus annotations to enable scraping:

```yaml
# In values.yaml
backend:
  podAnnotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "3001"
    prometheus.io/path: "/metrics"
```

### Grafana Dashboards

Import dashboard JSON for OpenLane Scheduler metrics (create custom dashboard monitoring reservation counts, lane status, etc.)

### Health Checks

```bash
# Backend health
curl https://bowling.example.com/api/health

# Or from within cluster
kubectl exec -it <any-pod> -- curl http://openlanescheduler-backend:3001/health
```

---

## Security Best Practices

1. **Use Secrets for Sensitive Data**
   ```bash
   kubectl create secret generic gcal-creds \
     --from-file=service-account.json \
     -n openlanescheduler
   ```

2. **Network Policies** (restrict pod-to-pod communication)
3. **RBAC** (limit service account permissions)
4. **Pod Security Policies** (enforce security standards)
5. **Image Scanning** (scan for vulnerabilities before deployment)
6. **Regular Updates** (keep dependencies and base images up to date)

---

## Cleanup

```bash
# Uninstall Helm release
helm uninstall openlanescheduler -n openlanescheduler

# Delete PVCs (if not auto-deleted)
kubectl delete pvc -l app.kubernetes.io/instance=openlanescheduler -n openlanescheduler

# Delete namespace
kubectl delete namespace openlanescheduler
```

---

## Next Steps

- Set up monitoring with Prometheus + Grafana
- Configure automated backups for Redis
- Set up CI/CD pipeline for automated deployments
- Configure horizontal pod autoscaling
- Set up alerting for critical issues
- Review and apply network policies

For questions or issues, see the main README.md and DEVELOPER_GUIDE.md.
