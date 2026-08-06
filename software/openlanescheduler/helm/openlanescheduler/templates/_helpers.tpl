{{/*
Expand the name of the chart.
*/}}
{{- define "openlanescheduler.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "openlanescheduler.fullname" -}}
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
{{- define "openlanescheduler.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "openlanescheduler.labels" -}}
helm.sh/chart: {{ include "openlanescheduler.chart" . }}
{{ include "openlanescheduler.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "openlanescheduler.selectorLabels" -}}
app.kubernetes.io/name: {{ include "openlanescheduler.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "openlanescheduler.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "openlanescheduler.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Redis connection URL
*/}}
{{- define "openlanescheduler.redisUrl" -}}
{{- if .Values.redis.enabled }}
{{- printf "redis://%s-redis:6379" (include "openlanescheduler.fullname" .) }}
{{- else }}
{{- .Values.redis.externalUrl }}
{{- end }}
{{- end }}

{{/*
Backend service name
*/}}
{{- define "openlanescheduler.backend.fullname" -}}
{{- printf "%s-backend" (include "openlanescheduler.fullname" .) }}
{{- end }}

{{/*
Frontend service name
*/}}
{{- define "openlanescheduler.frontend.fullname" -}}
{{- printf "%s-frontend" (include "openlanescheduler.fullname" .) }}
{{- end }}

{{/*
Redis service name
*/}}
{{- define "openlanescheduler.redis.fullname" -}}
{{- printf "%s-redis" (include "openlanescheduler.fullname" .) }}
{{- end }}
