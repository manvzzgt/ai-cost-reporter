require("dotenv").config();
const { S3Client, HeadObjectCommand } = require("@aws-sdk/client-s3");
const { collect, loadUserMap } = require("../collectors/openai");
const { write } = require("../shared/s3Writer");

// ==========================
// 🔹 VALIDACION
// ==========================
if (!process.env.OPENAI_ADMIN_KEY) {
  console.error("Error: falta la variable de entorno OPENAI_ADMIN_KEY");
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

function dateToRange(date) {
  const start = new Date(`${date}T00:00:00Z`);
  const end   = new Date(`${date}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return {
    start_time: Math.floor(start.getTime() / 1000),
    end_time:   Math.floor(end.getTime()   / 1000),
  };
}

function buildS3Key(date) {
  const [year, month, day] = date.split("-");
  return `data/provider=openai/year=${year}/month=${month}/day=${day}/report.jsonl`;
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
// 🔥 MAIN
// ==========================
async function main() {
  const dates = buildDateRange(process.env.START_DATE);

  console.log(`Backfill OpenAI: ${dates[0]} → ${dates[dates.length - 1]} (${dates.length} días)\n`);

  console.log("Cargando userMap...");
  const userMap = await loadUserMap();
  console.log(`userMap cargado: ${Object.keys(userMap).length} usuarios\n`);

  const stats = { written: 0, skipped: 0, empty: 0, errors: 0 };

  for (const date of dates) {
    const key = buildS3Key(date);

    try {
      if (await existsInS3(key)) {
        console.log(`⏭  ${date} — skipping (ya existe en S3)`);
        stats.skipped++;
        continue;
      }

      const { start_time, end_time } = dateToRange(date);
      const data = await collect({ start_time, end_time, userMap });

      if (!data.length) {
        console.log(`○  ${date} — sin actividad`);
        stats.empty++;
      } else {
        await write({ data, provider: "openai", date });
        console.log(`✓  ${date} — ${data.length} registros escritos`);
        stats.written++;
      }
    } catch (err) {
      console.error(`✗  ${date} — error: ${err.message}`);
      stats.errors++;
    }

    await sleep(500);
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
