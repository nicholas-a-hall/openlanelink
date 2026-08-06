{{/*
Expand the name of the chart.
*/}}
{{- define "lunar-lanes.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "lunar-lanes.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "lunar-lanes.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "lunar-lanes.labels" -}}
helm.sh/chart: {{ include "lunar-lanes.chart" . }}
{{ include "lunar-lanes.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "lunar-lanes.selectorLabels" -}}
app.kubernetes.io/name: {{ include "lunar-lanes.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "lunar-lanes.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "lunar-lanes.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Redis connection URL
*/}}
{{- define "lunar-lanes.redisUrl" -}}
{{- if .Values.redis.enabled }}
{{- printf "redis://%s-redis:6379" (include "lunar-lanes.fullname" .) }}
{{- else }}
{{- .Values.redis.externalUrl }}
{{- end }}
{{- end }}

{{/*
Backend service name
*/}}
{{- define "lunar-lanes.backend.fullname" -}}
{{- printf "%s-backend" (include "lunar-lanes.fullname" .) }}
{{- end }}

{{/*
Frontend service name
*/}}
{{- define "lunar-lanes.frontend.fullname" -}}
{{- printf "%s-frontend" (include "lunar-lanes.fullname" .) }}
{{- end }}

{{/*
Redis service name
*/}}
{{- define "lunar-lanes.redis.fullname" -}}
{{- printf "%s-redis" (include "lunar-lanes.fullname" .) }}
{{- end }}
