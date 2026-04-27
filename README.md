# 🤖 AI Cost Collector

Serverless pipeline para recolección y normalización de costos diarios de APIs de IA.
Corre como Lambda en AWS, escribe JSONL particionado a S3 y expone los datos vía Athena.

---

## 🏗️ Arquitectura

```
EventBridge (cron 8:00 AM UTC)
        │
        ▼
  Lambda: ai-costs-collector
  ┌─────────────────────────────────┐
  │  index.js (dispatcher)          │
  │    ├── collectors/openai.js     │
  │    ├── collectors/vertex.js     │
  │    ├── collectors/elevenlabs.js │  ← pendiente
  │    └── ...                      │
  │                                 │
  │  shared/s3Writer.js             │
  └─────────────────────────────────┘
        │
        ▼
  S3: ai-costs-lake
  data/provider={p}/year={Y}/month={M}/day={D}/report.jsonl
        │
        ▼
  Athena (ai_costs_db) — Partition Projection
  └── v_ai_costs_enriched (LEFT JOIN service_mapping)
        │
        ▼
  Power BI Dashboard  ← pendiente
        │
  DLQ + CloudWatch Alarm + SNS email (alertas de fallos)
```

---

## 📁 Estructura del proyecto

```
api-costs-v2/
├── index.js                      # Lambda handler / dispatcher
├── athena_setup.sql              # DDL tabla Athena con Partition Projection
├── collectors/
│   ├── openai.js                 # Collector OpenAI (Admin API)
│   └── vertex.js                 # Collector Vertex AI + Gemini API (BigQuery billing)
├── shared/
│   └── s3Writer.js               # Módulo compartido de escritura a S3
├── config/
│   └── service_mapping.json      # Mapeo user_name → solución/cliente (26 entradas)
├── scripts/
│   ├── package-lambda.js         # Empaquetador ZIP para Lambda
│   ├── backfill-openai.js        # Backfill histórico OpenAI
│   └── backfill-vertex.js        # Backfill histórico Vertex AI
└── test/
    ├── test-openai.js
    ├── test-vertex.js
    └── test-handler.js
```

---

## 📄 Schema de salida (`ai_costs`)

Cada fila del JSONL sigue este schema común:

| Campo | Tipo | Descripción |
|---|---|---|
| `date` | string | Fecha del reporte `YYYY-MM-DD` |
| `project_id` | string | ID del proyecto en el proveedor |
| `user_name` | string | Nombre del usuario o service account |
| `model` | string | Modelo utilizado |
| `operation_type` | string | `input_text`, `input_audio`, `input_image`, `input_cached`, `output_text`, `output_thinking` |
| `tier` | string | `standard` o `priority` (null en OpenAI) |
| `input_units` | int | Tokens de entrada (sin caché) |
| `output_units` | int | Tokens de salida |
| `cached_tokens` | int | Tokens servidos desde caché |
| `unit_type` | string | `"tokens"` (o `"characters"` para otros proveedores) |
| `requests` | int | Número de requests — null en Vertex AI |
| `total_usd` | float | Costo en USD |
| `total_mxn` | float | Costo en MXN (null en OpenAI, poblado en Vertex AI) |
| `fx_rate` | float | MXN por USD del día (null en OpenAI, poblado en Vertex AI) |
| `sku_raw` | string | SKU original de la API del proveedor |

> El campo `provider` va en la partición S3, no en el JSONL — Athena lo expone como columna virtual vía Partition Projection.

### Partición S3

```
data/provider={provider}/year={YYYY}/month={MM}/day={DD}/report.jsonl
```

---

## 🔍 Collectors

### OpenAI (`collectors/openai.js`)

- Fuente: OpenAI Admin API (`/v1/organization/costs`, `/v1/organization/usage/completions`, `/embeddings`)
- Agrupa por `userId + model + operation_type + projectId`
- Resuelve nombres vía `/organization/projects/*/service_accounts` y `/organization/users`
- Retry automático con backoff exponencial (2s / 4s / 8s) para errores `429, 500, 502, 503, 504`
- Timeout de 120 segundos por request

### Vertex AI (`collectors/vertex.js`)

- Fuente: BigQuery tabla `billing_export.gcp_billing_export_v1_01C77B_46625E_B652C8` (proyecto `viva-calidad-ia`)
- Captura tanto Vertex AI (label `servicio`) como Gemini API directa (`user_name = "gemini-api-direct"`)
- Mapeo de SKUs a `operation_type` y `tier` (standard / priority)
- Conversión MXN → USD vía [frankfurter.app](https://frankfurter.app), guardando `fx_rate` y `total_mxn` para auditoría
- Credenciales duales: `GOOGLE_APPLICATION_CREDENTIALS` (local) o `GOOGLE_CREDENTIALS_JSON` (Lambda)

---

## 🚀 Desarrollo local

### 1. Instalar dependencias

```bash
npm install
```

### 2. Configurar variables de entorno

Crea un archivo `.env` en la raíz:

```env
# OpenAI
OPENAI_ADMIN_KEY=sk-admin-...

# Vertex AI — local (path al JSON del service account)
GOOGLE_APPLICATION_CREDENTIALS=/ruta/a/credentials.json

# AWS
S3_BUCKET=ai-costs-lake
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

### 3. Scripts disponibles

```bash
# Prueba local de cada collector (llama a la API y escribe en S3)
npm run test:openai
npm run test:vertex

# Prueba local del dispatcher Lambda completo (openai + vertex_ai)
npm run test:handler

# Backfill histórico
START_DATE=2026-01-01 npm run backfill:openai
START_DATE=2026-01-01 npm run backfill:vertex

# Genera lambda-deploy.zip listo para subir a AWS
npm run package
```

---

## 📦 Deploy

### 1. Generar el ZIP

```bash
npm run package
# → lambda-deploy.zip (~8 MB)
```

### 2. Subir a Lambda

```bash
aws lambda update-function-code \
  --function-name ai-costs-collector \
  --zip-file fileb://lambda-deploy.zip
```

### 3. Variables de entorno en Lambda

Las credenciales se configuran directamente en la consola de Lambda o vía CLI — **no se usa `.env` en producción**:

```bash
aws lambda update-function-configuration \
  --function-name ai-costs-collector \
  --environment "Variables={
    OPENAI_ADMIN_KEY=sk-admin-...,
    GOOGLE_CREDENTIALS_JSON={...json...},
    S3_BUCKET=ai-costs-lake
  }"
```

`AWS_REGION` es inyectada automáticamente por el runtime de Lambda.

### 4. Invocar manualmente

```bash
# Un solo provider
aws lambda invoke \
  --function-name ai-costs-collector \
  --payload '{"providers":["openai"]}' \
  response.json

# Ambos providers
aws lambda invoke \
  --function-name ai-costs-collector \
  --payload '{"providers":["openai","vertex_ai"]}' \
  response.json
```

### 5. Configurar tabla Athena

Ejecutar `athena_setup.sql` en la consola de Athena (una sola vez, o tras cambios de schema).
Usa **Partition Projection** — no requiere Glue Crawler ni `MSCK REPAIR TABLE`.

---

## 🗺️ Roadmap

- [x] Collector OpenAI
- [x] Pipeline Lambda + S3 + Athena
- [x] Deploy automático con EventBridge (cron diario 8:00 AM UTC)
- [x] Alertas DLQ + CloudWatch + SNS email
- [x] Collector Vertex AI
- [x] Backfill histórico OpenAI + Vertex AI
- [x] Vista Athena `v_ai_costs_enriched` + `service_mapping`
- [ ] Collector ElevenLabs
- [ ] Collector Deepgram
- [ ] Collector VAPI
- [ ] Dashboard Power BI

---

## 🔒 Seguridad

- En local: las credenciales van en `.env` (excluido del repo vía `.gitignore`)
- En producción: las credenciales van en variables de entorno de Lambda — nunca en el código ni en el ZIP
- Las credenciales GCP para Lambda se pasan como JSON serializado en `GOOGLE_CREDENTIALS_JSON`

---

## 👤 Autor

**Manuel Vazquez**
- GitHub: [@manvzzgt](https://github.com/manvzzgt)
- Email: manuel.vazquez@enginetsystems.com
