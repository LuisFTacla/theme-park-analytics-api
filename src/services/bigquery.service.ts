// src/services/bigquery.service.ts

import { BigQuery } from '@google-cloud/bigquery';
import NodeCache from 'node-cache';
import {
  HourlyAverage, DailyAverage, HeatmapDataPoint, DailyEvolutionPoint,
  HistoricalRawData, DailyRideAverage, ForecastResponse, BacktestPoint,
} from '../types';

// Cache em memória: TTL em segundos
const cache = new NodeCache();
const CACHE_TTL = {
  PARKS: 86400,       // 24h — lista de parques muda raramente
  HOURLY: 3600,       // 1h  — médias históricas
  DAILY: 3600,        // 1h
  HEATMAP: 3600,      // 1h
  EVOLUTION: 120,     // 2min — dados do dia atual mudam com frequência
  DAILY_BY_RIDE: 3600,   // 1h  — histórico recente por atração (input do forecast)
  FORECAST: 6 * 3600,    // 6h  — previsão não precisa recalcular a cada request
  BACKTEST: 24 * 3600,   // 24h — só muda quando gerar_backtest.py é rerodado (mensal)
};

const DATASET = 'theme-park-queue-data.theme_park_queues.historical-data';
const BACKTEST_TABLE = 'theme-park-queue-data.theme_park_queues.backtest_previsoes';

// Endpoint do microsserviço Python de previsão (forecast_service.py)
const FORECAST_SERVICE_URL = process.env.FORECAST_SERVICE_URL ?? 'http://localhost:8000';

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
  timezone: string,
  rideId?: number,
  year?: number
): Promise<HistoricalRawData[]> {
  const cacheKey = `raw:${parkId}:${rideId ?? 'all'}:${year ?? 'all'}`;
  const cached = cache.get<HistoricalRawData[]>(cacheKey);
  if (cached) return cached;

  // Construção dinâmica de filtros SQL
  let filterConditions = '';
  if (rideId) {
    filterConditions += ` AND ride_id = ${rideId}`;
  }
  if (year) {
    filterConditions += ` AND EXTRACT(YEAR FROM DATETIME(timestamp_utc, '${timezone}')) = ${year}`;
  }

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
      ${filterConditions}
    ORDER BY timestamp_utc DESC
    LIMIT 50000
  `;

  const [rows] = await bq.query({ query });
  const result = rows as HistoricalRawData[];

  // Mantemos o cache de 5 minutos
  cache.set(cacheKey, result, 300); 
  return result;
}

// ─── HISTÓRICO DIÁRIO POR ATRAÇÃO (input do modelo de forecast) ──────────────

export async function getDailyAveragesByRide(
  parkId: number,
  timezone: string,
  lookbackDays = 120
): Promise<DailyRideAverage[]> {
  const cacheKey = `daily_ride:${parkId}:${timezone}:${lookbackDays}`;
  const cached = cache.get<DailyRideAverage[]>(cacheKey);
  if (cached) return cached;

  const query = `
    SELECT
      ${RIDE_NAME_EXPR} as name,
      DATE(timestamp_utc, '${timezone}') as data_local,
      AVG(wait_time) as avg_wait_time,
      COUNT(*) as n_leituras
    FROM \`${DATASET}\`
    WHERE park_id = ${parkId}
      AND wait_time > 0
      AND DATE(timestamp_utc, '${timezone}') >= DATE_SUB(CURRENT_DATE('${timezone}'), INTERVAL ${lookbackDays} DAY)
    GROUP BY name, data_local
    HAVING n_leituras >= 20
    ORDER BY data_local
  `;

  const [rows] = await bq.query({ query });
  const result: DailyRideAverage[] = rows.map((r: any) => ({
    name: String(r.name),
    data_local: typeof r.data_local === 'object' ? r.data_local.value : String(r.data_local),
    avg_wait_time: Number(r.avg_wait_time),
  }));

  cache.set(cacheKey, result, CACHE_TTL.DAILY_BY_RIDE);
  return result;
}

// ─── PREVISÃO (chama o microsserviço Python) ──────────────────────────────────

export async function getForecast(
  parkId: number,
  timezone: string,
  days = 14
): Promise<ForecastResponse> {
  const cacheKey = `forecast:${parkId}:${timezone}:${days}`;
  const cached = cache.get<ForecastResponse>(cacheKey);
  if (cached) return cached;

  const historico = await getDailyAveragesByRide(parkId, timezone);
  if (!historico.length) {
    throw new Error('Sem histórico suficiente para gerar previsão.');
  }

  const resp = await fetch(`${FORECAST_SERVICE_URL}/predict`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ historico, dias: days }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Forecast service error (${resp.status}): ${errText}`);
  }

  const result = (await resp.json()) as ForecastResponse;
  cache.set(cacheKey, result, CACHE_TTL.FORECAST);
  return result;
}

// ─── PREVISÃO AGREGADA POR DIA (para mesclar no calendário) ──────────────────

export async function getForecastCalendarDays(
  parkId: number,
  timezone: string,
  days = 7
): Promise<DailyAverage[]> {
  const cacheKey = `forecast_calendar:${parkId}:${timezone}:${days}`;
  const cached = cache.get<DailyAverage[]>(cacheKey);
  if (cached) return cached;

  const forecast = await getForecast(parkId, timezone, days);

  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // Agrega a previsão por atração em uma média diária do parque,
  // na mesma métrica usada pelo calendário histórico (getDailyAverages)
  const porDia = new Map<string, number[]>();
  for (const p of forecast.previsoes) {
    const arr = porDia.get(p.data_local) ?? [];
    arr.push(p.pred_wait_time);
    porDia.set(p.data_local, arr);
  }

  const result: DailyAverage[] = [...porDia.entries()].map(([dateStr, vals]) => {
    const date = new Date(`${dateStr}T00:00:00Z`);
    const media = vals.reduce((a, b) => a + b, 0) / vals.length;
    const startOfYear = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const weekOfYear = Math.ceil(
      ((date.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getUTCDay() + 1) / 7
    );

    return {
      data_local: dateStr,
      ano_registro: date.getUTCFullYear(),
      wait_time: Math.round(media),
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      day_of_week: DAY_NAMES[date.getUTCDay()],
      week_of_year: weekOfYear,
      is_forecast: true,
    };
  });

  cache.set(cacheKey, result, CACHE_TTL.FORECAST);
  return result;
}

// ─── VALIDAÇÃO / BACKTEST (tabela estática, atualizada mensalmente) ──────────

export async function getBacktestData(parkId: number): Promise<BacktestPoint[]> {
  const cacheKey = `backtest:${parkId}`;
  const cached = cache.get<BacktestPoint[]>(cacheKey);
  if (cached) return cached;

  // Nota: a tabela hoje cobre só o BCW (park_id 319) — se você expandir o
  // backtest para outros parques, adicione uma coluna park_id na exportação
  // do gerar_backtest.py e filtre aqui.
  const query = `
    SELECT data_local, name, wait_time_real, wait_time_previsto, mes_referencia, abs_erro
    FROM \`${BACKTEST_TABLE}\`
    ORDER BY data_local
  `;
  const [rows] = await bq.query({ query });
  const result: BacktestPoint[] = rows.map((r: any) => ({
    data_local: typeof r.data_local === 'object' ? r.data_local.value : String(r.data_local),
    name: String(r.name),
    wait_time_real: Number(r.wait_time_real),
    wait_time_previsto: Number(r.wait_time_previsto),
    mes_referencia: String(r.mes_referencia),
    abs_erro: Number(r.abs_erro),
  }));

  cache.set(cacheKey, result, CACHE_TTL.BACKTEST);
  return result;
}