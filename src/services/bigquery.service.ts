// src/services/bigquery.service.ts

import { BigQuery } from '@google-cloud/bigquery';
import NodeCache from 'node-cache';
import { HourlyAverage, DailyAverage, HeatmapDataPoint, DailyEvolutionPoint, HistoricalRawData } from '../types';

// Cache em memória: TTL em segundos
const cache = new NodeCache();
const CACHE_TTL = {
  PARKS: 86400,       // 24h — lista de parques muda raramente
  HOURLY: 3600,       // 1h  — médias históricas
  DAILY: 3600,        // 1h
  HEATMAP: 3600,      // 1h
  EVOLUTION: 120,     // 2min — dados do dia atual mudam com frequência
};

const DATASET = 'theme-park-queue-data.theme_park_queues.historical-data';

// Inicializa o cliente BigQuery a partir de variável de ambiente (JSON em base64 ou path)
function createBigQueryClient(): BigQuery {
  const credsBase64 = process.env.BQ_CREDENTIALS_BASE64;

  if (credsBase64) {
    const creds = JSON.parse(Buffer.from(credsBase64, 'base64').toString('utf-8'));
    return new BigQuery({
      credentials: creds,
      projectId: creds.project_id,
    });
  }

  // Fallback: usa GOOGLE_APPLICATION_CREDENTIALS do ambiente
  return new BigQuery();
}

const bq = createBigQueryClient();

// Helper para montar a expressão de normalização de nomes
const RIDE_NAME_EXPR = `
  CASE 
    WHEN ride_name IN ('Big Tower', 'BIG TOWER', 'big tower') THEN 'Big Drop'
    ELSE ride_name 
  END
`;

// ─── PARQUES DISPONÍVEIS ───────────────────────────────────────────────────────

export async function getAvailableParks() {
  const cacheKey = 'parks:all';
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const query = `
    SELECT DISTINCT park_id, park_name 
    FROM \`${DATASET}\` 
    ORDER BY park_name
  `;
  const [rows] = await bq.query({ query });
  cache.set(cacheKey, rows, CACHE_TTL.PARKS);
  return rows;
}

// ─── MÉDIAS HORÁRIAS ──────────────────────────────────────────────────────────

export async function getHourlyAverages(
  parkId: number,
  timezone: string
): Promise<HourlyAverage[]> {
  const cacheKey = `hourly:${parkId}:${timezone}`;
  const cached = cache.get<HourlyAverage[]>(cacheKey);
  if (cached) return cached;

  const query = `
    SELECT 
      ${RIDE_NAME_EXPR} as name,
      EXTRACT(HOUR FROM DATETIME(timestamp_utc, '${timezone}')) as hora_cheia,
      AVG(wait_time) as wait_time
    FROM \`${DATASET}\`
    WHERE park_id = ${parkId}
      AND wait_time > 0
      AND EXTRACT(HOUR FROM DATETIME(timestamp_utc, '${timezone}')) BETWEEN 8 AND 22
    GROUP BY name, hora_cheia
    ORDER BY name, hora_cheia
  `;

  const [rows] = await bq.query({ query });
  const result = rows as HourlyAverage[];
  cache.set(cacheKey, result, CACHE_TTL.HOURLY);
  return result;
}

// ─── MÉDIAS DIÁRIAS (CALENDÁRIO) ──────────────────────────────────────────────

export async function getDailyAverages(
  parkId: number,
  timezone: string
): Promise<{ data: DailyAverage[]; years: number[] }> {
  const cacheKey = `daily:${parkId}:${timezone}`;
  const cached = cache.get<{ data: DailyAverage[]; years: number[] }>(cacheKey);
  if (cached) return cached;

  const query = `
    SELECT 
      DATE(timestamp_utc, '${timezone}') as data_local,
      EXTRACT(YEAR FROM DATETIME(timestamp_utc, '${timezone}')) as ano_registro,
      ROUND(AVG(wait_time), 0) as wait_time
    FROM \`${DATASET}\`
    WHERE park_id = ${parkId}
      AND wait_time > 0
    GROUP BY data_local, ano_registro
    ORDER BY data_local
  `;

  const [rows] = await bq.query({ query });

  if (!rows.length) {
    return { data: [], years: [] };
  }

  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  const enriched: DailyAverage[] = rows.map((row: any) => {
    const dateStr: string = typeof row.data_local === 'object'
      ? row.data_local.value
      : String(row.data_local);
    
    // Forçamos o append de "T00:00:00Z" para garantir o parse isolado em UTC puro
    const date = new Date(`${dateStr}T00:00:00Z`);

    // week_of_year calculada de forma segura usando os milissegundos UTC
    const startOfYear = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const weekOfYear = Math.ceil(((date.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getUTCDay() + 1) / 7);

    return {
      data_local: dateStr,
      ano_registro: Number(row.ano_registro),
      wait_time: Number(row.wait_time),
      // 🌟 LER SEMPRE OS MÉTODOS UTC PARA NÃO DEPENDER DO FUSO DO SERVIDOR
      year:  date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day:   date.getUTCDate(),
      day_of_week: DAY_NAMES[date.getUTCDay()],
      week_of_year: weekOfYear,
    };
  });

  const years = [...new Set(enriched.map(r => r.year))].sort();
  const result = { data: enriched, years };
  cache.set(cacheKey, result, CACHE_TTL.DAILY);
  return result;
}

// ─── HEATMAP DIÁRIO ───────────────────────────────────────────────────────────

export async function getDailyHeatmapData(
  parkId: number,
  timezone: string,
  date: string,
  intervalMinutes: number
): Promise<HeatmapDataPoint[]> {
  const cacheKey = `heatmap:${parkId}:${timezone}:${date}:${intervalMinutes}`;
  const cached = cache.get<HeatmapDataPoint[]>(cacheKey);
  if (cached) return cached;

  const bloco = intervalMinutes;
  const query = `
    WITH dados_indexados AS (
      SELECT 
        ${RIDE_NAME_EXPR} as name,
        wait_time,
        EXTRACT(HOUR   FROM DATETIME(timestamp_utc, '${timezone}')) as hora,
        EXTRACT(MINUTE FROM DATETIME(timestamp_utc, '${timezone}')) as minuto
      FROM \`${DATASET}\`
      WHERE park_id = ${parkId}
        AND DATE(timestamp_utc, '${timezone}') = '${date}'
        AND EXTRACT(HOUR FROM DATETIME(timestamp_utc, '${timezone}')) BETWEEN 8 AND 22
    )
    SELECT 
      name,
      hora,
      DIV(minuto, ${bloco}) * ${bloco} as minuto_bloco,
      ROUND(AVG(wait_time), 0) as wait_time_medio
    FROM dados_indexados
    GROUP BY name, hora, minuto_bloco
    ORDER BY name, hora, minuto_bloco
  `;

  const [rows] = await bq.query({ query });
  const result = (rows as HeatmapDataPoint[]).map(r => ({
    ...r,
    label_tempo:
      String(r.hora).padStart(2, '0') + ':' + String(r.minuto_bloco).padStart(2, '0'),
  }));

  // Dados do dia atual têm TTL menor para refletir atualizações mais rápidas
  const isToday = date === new Date().toISOString().split('T')[0];
  cache.set(cacheKey, result, isToday ? CACHE_TTL.EVOLUTION : CACHE_TTL.HEATMAP);
  return result;
}

// ─── EVOLUÇÃO DIÁRIA (GRÁFICO DE LINHA) ───────────────────────────────────────

export async function getDailyEvolution(
  parkId: number,
  timezone: string,
  date: string
): Promise<DailyEvolutionPoint[]> {
  const cacheKey = `evolution:${parkId}:${timezone}:${date}`;
  const cached = cache.get<DailyEvolutionPoint[]>(cacheKey);
  if (cached) return cached;

  const query = `
    SELECT 
      EXTRACT(HOUR   FROM DATETIME(timestamp_utc, '${timezone}')) as hora,
      EXTRACT(MINUTE FROM DATETIME(timestamp_utc, '${timezone}')) as minuto,
      AVG(wait_time) as wait_time
    FROM \`${DATASET}\`
    WHERE park_id = ${parkId}
      AND DATE(timestamp_utc, '${timezone}') = '${date}'
    GROUP BY hora, minuto
    ORDER BY hora, minuto
  `;

  const [rows] = await bq.query({ query });
  const result: DailyEvolutionPoint[] = (rows as any[]).map(r => ({
    horario: String(r.hora).padStart(2, '0') + ':' + String(r.minuto).padStart(2, '0'),
    wait_time: Number(r.wait_time),
  }));

  const isToday = date === new Date().toISOString().split('T')[0];
  cache.set(cacheKey, result, isToday ? CACHE_TTL.EVOLUTION : CACHE_TTL.HEATMAP);
  return result;
}

// ─── DADOS AO VIVO (BIGQUERY) ──────────────────────────────────────────────────

export async function getLiveFromBigQuery(parkId: number): Promise<any[]> {
  const cacheKey = `live:bq:${parkId}`;
  const cached = cache.get<any[]>(cacheKey);
  if (cached) return cached;

  // Query que descobre o último timestamp inserido para o parque
  // e traz todas as atrações registradas exatamente nesse instante.
  const query = `
    WITH ultimo_registro AS (
      SELECT MAX(timestamp_utc) as max_ts
      FROM \`${DATASET}\`
      WHERE park_id = ${parkId}
    )
    SELECT 
      ride_id as id,
      ${RIDE_NAME_EXPR} as name,
      -- Se o seu job já salva o estado (aberto/fechado), ajuste o campo abaixo. 
      -- Caso não salve, assumimos true se houver tempo de espera ou mapeie o campo correto.
      IFNULL(is_open, true) as is_open, 
      wait_time
    FROM \`${DATASET}\`, ultimo_registro
    WHERE park_id = ${parkId}
      AND timestamp_utc = ultimo_registro.max_ts
    ORDER BY name
  `;

  const [rows] = await bq.query({ query });
  
  // Como os dados já vêm tratados e filtrados pelo seu Job de coleta no BigQuery,
  // basta tipar e estruturar o retorno esperado pela rota.
  const result = rows.map(r => ({
    id: Number(r.id),
    name: String(r.name),
    is_open: Boolean(r.is_open),
    wait_time: Number(r.wait_time)
  }));

  // Salva no cache de curta duração (2 minutos)
  cache.set(cacheKey, result, CACHE_TTL.EVOLUTION);
  return result;
}

// ─── DADOS HISTÓRICOS BRUTOS POR PARQUE ──────────────────────────────────────────

export async function getRawHistoricalData(
  parkId: number,
  timezone: string
): Promise<HistoricalRawData[]> {
  const cacheKey = `raw:${parkId}:${timezone}`;
  const cached = cache.get<HistoricalRawData[]>(cacheKey);
  if (cached) return cached;

  // Query trazendo as colunas essenciais ordenadas pela data/hora mais recente
  const query = `
    SELECT 
      FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E3SZ', timestamp_utc) as timestamp_utc,
      STRING(DATE(timestamp_utc, '${timezone}')) as data_local,
      ride_id,
      ${RIDE_NAME_EXPR} as name,
      wait_time,
      IFNULL(is_open, true) as is_open
    FROM \`${DATASET}\`
    WHERE park_id = ${parkId}
    ORDER BY timestamp_utc DESC
    LIMIT 50000
  `;

  const [rows] = await bq.query({ query });
  const result = rows as HistoricalRawData[];

  // Cache curto de 5 minutos (300 segundos) para poupar processamento repetido
  cache.set(cacheKey, result, 300); 
  return result;
}