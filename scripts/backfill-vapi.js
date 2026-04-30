require("dotenv").config();
const { S3Client, HeadObjectCommand } = require("@aws-sdk/client-s3");
const { collect } = require("../collectors/vapi");
const { write } = require("../shared/s3Writer");

// ==========================
// 🔹 VALIDACION
// ==========================
if (!process.env.VAPI_API_KEYS) {
  console.error("Error: falta la variable de entorno VAPI_API_KEYS");
  process.exit(1);
}
if (!process.env.START_DATE) {
  console.error("Error: falta la variable de entorno START_DATE (formato YYYY-MM-DD)");
  process.exit(1);
}

const BUCKET  = process.env.S3_BUCKET  || "ai-costs-lake";
const REGION  = process.env.AWS_REGION || "us-east-1";
const s3      = new S3Client({ region: REGION });

// ==========================
// 🔹 UTILIDADES
// ==========================
function buildDateRange(startDate) {
  const dates = [];
  const start = new Date(`${startDate}T00:00:00Z`);
  const now   = new Date();
  const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));

  for (let d = new Date(start); d <= yesterday; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().split("T")[0]);
  }
  return dates;
}

function buildS3Key(date) {
  const [year, month, day] = date.split("-");
  return `data/provider=vapi/year=${year}/month=${month}/day=${day}/report.jsonl`;
}

async function existsInS3(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch (err) {
    if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==========================
// 🔹 RETRY CON BACKOFF
// ==========================
const RETRY_DELAYS_MS = [2000, 4000, 8000];

async function collectWithRetry(date) {
  let lastError;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await collect({ date });
    } catch (err) {
      const status = err.response?.status;
      if (status !== 429 || attempt === RETRY_DELAYS_MS.length) throw err;
      const delay = RETRY_DELAYS_MS[attempt];
      console.warn(`[vapi] Reintento ${attempt + 1}/3 — status 429 para ${date} (esperando ${delay}ms)`);
      lastError = err;
      await sleep(delay);
    }
  }

  throw lastError;
}

// ==========================
// 🔥 MAIN
// ==========================
async function main() {
  const dates = buildDateRange(process.env.START_DATE);

  console.log(`Backfill VAPI: ${dates[0]} → ${dates[dates.length - 1]} (${dates.length} días)\n`);

  const stats = { written: 0, skipped: 0, empty: 0, errors: 0 };

  for (const date of dates) {
    const key = buildS3Key(date);

    try {
      if (await existsInS3(key)) {
        console.log(`⏭  ${date} — skipping (ya existe en S3)`);
        stats.skipped++;
        continue;
      }

      const data = await collectWithRetry(date);

      if (!data.length) {
        console.log(`○  ${date} — sin actividad`);
        stats.empty++;
      } else {
        await write({ data, provider: "vapi", date });
        console.log(`✓  ${date} — ${data.length} registros escritos`);
        stats.written++;
      }
    } catch (err) {
      console.error(`✗  ${date} — error: ${err.message}`);
      stats.errors++;
    }

    await sleep(2000);
  }

  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Backfill completado
  ✓ Escritos:  ${String(stats.written).padStart(4)}
  ⏭ Skipped:  ${String(stats.skipped).padStart(4)}
  ○ Sin datos: ${String(stats.empty).padStart(4)}
  ✗ Errores:  ${String(stats.errors).padStart(4)}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  if (stats.errors > 0) process.exit(1);
}

main().catch(err => {
  console.error("Error fatal:", err.message);
  process.exit(1);
});
