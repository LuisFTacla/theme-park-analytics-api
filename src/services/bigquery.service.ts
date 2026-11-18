// src/services/bigquery.service.ts

import { BigQuery } from '@google-cloud/bigquery';
import NodeCache from 'node-cache';
import {
  HourlyAverage, DailyAverage, HeatmapDataPoint, DailyEvolutionPoint,
  DailyRideAverage, ForecastResponse, BacktestPoint,
  RideStats, RideHeatmapHistoryPoint, RideHistoricalProfilePoint, ShowSession,
  MAGIC_KINGDOM_MECHANICAL_IDS, EPCOT_MECHANICAL_IDS,
  HOLLYWOOD_STUDIOS_MECHANICAL_IDS,
  ANIMAL_KINGDOM_MECHANICAL_IDS
} from '../types';

// Cache em memória: TTL em segundos
const cache = new NodeCache();
const CACHE_TTL = {
  HOURLY: 3600,      // 1h  — médias históricas
  DAILY: 3600,        // 1h
  HEATMAP: 3600,      // 1h
  EVOLUTION: 120,     // 2min — dados do dia atual mudam com frequência
  DAILY_BY_RIDE: 3600,   // 1h  — histórico recente por atração (input do forecast)
  FORECAST: 6 * 3600,    // 6h  — previsão não precisa recalcular a cada request
  BACKTEST: 24 * 3600,   // 24h — só muda quando gerar_backtest.py é rerodado (mensal)
  RIDE_STATS: 3600,        // 1h  — média/máxima histórica e do dia, por atração
  RIDE_HEATMAP_HISTORY: 3600, // 1h — heatmap de uma atração ao longo de vários dias
  SHOWS: 1800,             // 30min — grade de shows só muda 2x/dia na coleta (10h/12h)
};

const DATASET = 'theme-park-queue-data.theme_park_queues.historical-data';
const BACKTEST_TABLE = 'theme-park-queue-data.theme_park_queues.backtest_previsoes';
const SHOWS_TABLE = 'theme-park-queue-data.theme_park_queues.bcw_shows_schedule';

// Agregados incrementais do histórico (ver sql/ na raiz da API). As consultas
// que olham "todos os dias" leem daqui em vez da tabela bruta: alguns MB por
// consulta em vez de 1-2 GB. Já vêm com o filtro de MAX_VALID_WAIT_TIME, a
// normalização de RIDE_NAME_EXPR e a hora local de cada parque aplicados.
const AGG_PROFILE_TABLE = 'theme-park-queue-data.theme_park_queues.agg_perfil_bloco';
const AGG_DAILY_TABLE = 'theme-park-queue-data.theme_park_queues.agg_media_diaria';
const AGG_CONTROL_TABLE = 'theme-park-queue-data.theme_park_queues.agg_controle';

/** Faixa de horário (local) considerada nos perfis históricos. */
const PROFILE_HOURS = { from: 8, to: 22 };

// Endpoint do microsserviço Python de previsão (forecast_service.py)
// Sem a variável, a previsão fica desligada — evita pagar a query de histórico
// (getDailyAveragesByRide) só pra depois falhar ao chamar um serviço inexistente.
const FORECAST_SERVICE_URL = process.env.FORECAST_SERVICE_URL;

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

export const bq = createBigQueryClient();

// Teto de tempo de espera considerado válido — mesmo valor já usado no resto
// do pipeline pra descartar erros de digitação de operadores (ex: 990 min).
const MAX_VALID_WAIT_TIME = 300;

// Consideramos que o "dia operacional" começa às 4h da manhã, não à meia-noite
// — horário em que nenhum parque opera, nem durante Extra Magic Hours da
// Disney. Sem isso, consultas por "DATE(timestamp_utc) = dia" cortam no meio
// da operação de parques que fecham depois da meia-noite, e o horário extra
// de hóspedes de hotel (que pertence à operação da noite ANTERIOR) vaza pro
// dia seguinte. Precisa ficar em sincronia com OPERATING_DAY_CUTOFF_HOUR no
// front (theme-park-analytics/src/utils/operatingHours.ts).
const OPERATING_DAY_START_HOUR = 4;

// A tabela é particionada por DATE(timestamp_utc) (UTC) e clusterizada por
// park_id. O BigQuery só poda partições com filtro direto em `timestamp_utc` —
// `DATE(timestamp_utc, '<tz>')` NÃO poda, e sem poda a query lê a tabela
// inteira (cobrança por bytes lidos). Por isso as queries limitadas no tempo
// levam um filtro redundante em `timestamp_utc`, com folga pra cobrir o fuso.

/** Janela de busca do status ao vivo — folga pra dias em que o parque não abre. */
const LIVE_LOOKBACK_DAYS = 7;

/**
 * Helper de SQL: alterna entre buscar o "corpo" de um dia (a partir de
 * `OPERATING_DAY_START_HOUR`) e a "cauda" que viraram a madrugada (antes de
 * `OPERATING_DAY_START_HOUR`, mas já no dia seguinte no calendário) — depois
 * ordena os dois trechos de forma contínua, cauda por último.
 */
function operatingDayWhereClause(timezone: string, date: string): string {
  // [dia-1, dia+2) em UTC cobre o dia operacional local em qualquer fuso.
  return `(
    timestamp_utc >= TIMESTAMP_SUB(TIMESTAMP('${date}'), INTERVAL 1 DAY)
    AND timestamp_utc < TIMESTAMP_ADD(TIMESTAMP('${date}'), INTERVAL 2 DAY)
    AND (
      (DATE(timestamp_utc, '${timezone}') = '${date}'
        AND EXTRACT(HOUR FROM DATETIME(timestamp_utc, '${timezone}')) >= ${OPERATING_DAY_START_HOUR})
      OR
      (DATE(timestamp_utc, '${timezone}') = DATE_ADD(DATE('${date}'), INTERVAL 1 DAY)
        AND EXTRACT(HOUR FROM DATETIME(timestamp_utc, '${timezone}')) < ${OPERATING_DAY_START_HOUR})
    )
  )`;
}

/** Expressão de ordenação contínua (corpo do dia, depois a cauda da madrugada seguinte). */
function operatingDayOrderBy(minuteColumn: string): string {
  return `MOD(hora * 60 + ${minuteColumn} - ${OPERATING_DAY_START_HOUR} * 60 + 1440, 1440)`;
}

// Helper para montar a expressão de normalização de nomes
const RIDE_NAME_EXPR = `
  CASE 
    WHEN ride_name IN ('Big Tower', 'BIG TOWER', 'big tower') THEN 'Big Drop'
    ELSE ride_name 
  END
`;

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

  // Os dias já acumulados vêm do agregado; o trecho que ainda não entrou nele
  // (desde `processado_ate`, menos de um dia normalmente) vem da tabela bruta,
  // pra o dia de hoje aparecer atualizado. O limite fixo de 7 dias existe só
  // pra podar partições -- filtro por subquery não poda.
  //
  // `sessoes` só tem linha pros dias em que a coleta de shows já rodou (a
  // partir de 2026-09-24) -- pra dias mais antigos o LEFT JOIN devolve NULL,
  // e o front simplesmente não mostra a contagem (ver CalendarGrid.tsx).
  const query = `
    WITH somas AS (
      SELECT data_local, n_positivos, soma_positivos
      FROM \`${AGG_DAILY_TABLE}\`
      WHERE park_id = @parkId
      UNION ALL
      SELECT DATE(timestamp_utc, @timezone), COUNT(*), SUM(wait_time)
      FROM \`${DATASET}\`
      WHERE park_id = @parkId
        AND timestamp_utc >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
        AND timestamp_utc >= (SELECT MAX(processado_ate) FROM \`${AGG_CONTROL_TABLE}\`)
        AND wait_time > 0
        AND wait_time <= @maxValid
      GROUP BY 1
    ),
    filas AS (
      SELECT
        data_local,
        EXTRACT(YEAR FROM data_local) as ano_registro,
        ROUND(SUM(soma_positivos) / SUM(n_positivos), 0) as wait_time
      FROM somas
      GROUP BY data_local
      HAVING SUM(n_positivos) > 0
    ),
    sessoes AS (
      -- Portal da Escuridão não é um show com sessões, é um labirinto que
      -- fica simplesmente aberto/fechado -- não entra nessa contagem.
      SELECT
        data_local,
        COUNT(DISTINCT CONCAT(CAST(atracao_id AS STRING), '|', periodo_de, '|', periodo_ate)) as show_sessions
      FROM \`${SHOWS_TABLE}\`
      WHERE park_id = @parkId
        AND nome != 'Portal da Escuridão'
      GROUP BY data_local
    )
    SELECT f.*, s.show_sessions
    FROM filas f
    LEFT JOIN sessoes s USING (data_local)
    ORDER BY f.data_local
  `;

  const [rows] = await bq.query({
    query,
    params: { parkId, timezone, maxValid: MAX_VALID_WAIT_TIME },
  });

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
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      day_of_week: DAY_NAMES[date.getUTCDay()],
      week_of_year: weekOfYear,
      show_sessions: row.show_sessions != null ? Number(row.show_sessions) : undefined,
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

  // Filtra atrações elegíveis no Heatmap do Magic Kingdom
  const MECHANICAL_IDS_BY_PARK: Record<number, number[]> = {
    6: MAGIC_KINGDOM_MECHANICAL_IDS,
    5: EPCOT_MECHANICAL_IDS,
    7: HOLLYWOOD_STUDIOS_MECHANICAL_IDS,
    8: ANIMAL_KINGDOM_MECHANICAL_IDS,
  };

  const parkIds = MECHANICAL_IDS_BY_PARK[parkId];
  const rideFilter = parkIds && parkIds.length > 0
    ? `AND ride_id IN (${parkIds.join(',')})`
    : '';

  const query = `
    WITH dados_indexados AS (
      SELECT
        ${RIDE_NAME_EXPR} as name,
        wait_time,
        EXTRACT(HOUR   FROM DATETIME(timestamp_utc, '${timezone}')) as hora,
        EXTRACT(MINUTE FROM DATETIME(timestamp_utc, '${timezone}')) as minuto
      FROM \`${DATASET}\`
      WHERE park_id = ${parkId}
        ${rideFilter}
        AND ${operatingDayWhereClause(timezone, date)}
    )
    SELECT
      name,
      hora,
      DIV(minuto, ${bloco}) * ${bloco} as minuto_bloco,
      ROUND(AVG(wait_time), 0) as wait_time_medio
    FROM dados_indexados
    GROUP BY name, hora, minuto_bloco
    ORDER BY name, ${operatingDayOrderBy('minuto_bloco')}
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

// ─── ESTATÍSTICAS DE UMA ATRAÇÃO (modal de detalhe) ──────────────────────────
// `rideName` vem de input do usuário (nome da atração, texto livre com acentos,
// parênteses etc.) — por isso usamos parâmetros nomeados do BigQuery em vez de
// interpolar a string na query, diferente do restante deste arquivo que só
// interpola valores já validados como número/data por regex.

export async function getRideStats(
  parkId: number,
  timezone: string,
  rideName: string,
  date: string
): Promise<RideStats> {
  const cacheKey = `ride_stats:${parkId}:${rideName}:${date}`;
  const cached = cache.get<RideStats>(cacheKey);
  if (cached) return cached;

  // Histórico vem do agregado; o dia selecionado, da tabela bruta com poda
  // de partição ([dia-1, dia+2) em UTC cobre a data local em qualquer fuso).
  const query = `
    WITH historico AS (
      SELECT
        ROUND(SAFE_DIVIDE(SUM(soma_positivos), SUM(n_positivos)), 0) as historical_avg,
        MAX(max_valido) as historical_max
      FROM \`${AGG_PROFILE_TABLE}\`
      WHERE park_id = @parkId AND ride_name = @rideName
    ),
    dia AS (
      SELECT
        ROUND(AVG(IF(wait_time > 0, wait_time, NULL)), 0) as daily_avg,
        MAX(wait_time) as daily_max
      FROM \`${DATASET}\`
      WHERE park_id = @parkId
        AND (${RIDE_NAME_EXPR}) = @rideName
        AND timestamp_utc >= TIMESTAMP_SUB(TIMESTAMP(@date), INTERVAL 1 DAY)
        AND timestamp_utc < TIMESTAMP_ADD(TIMESTAMP(@date), INTERVAL 2 DAY)
        AND DATE(timestamp_utc, @timezone) = @date
        AND wait_time <= @maxValid
    )
    SELECT * FROM historico CROSS JOIN dia
  `;

  const [rows] = await bq.query({
    query,
    params: { parkId, timezone, date, rideName, maxValid: MAX_VALID_WAIT_TIME },
  });

  const row = rows[0] ?? {};
  const result: RideStats = {
    historicalAvg: row.historical_avg != null ? Number(row.historical_avg) : null,
    historicalMax: row.historical_max != null ? Number(row.historical_max) : null,
    dailyAvg: row.daily_avg != null ? Number(row.daily_avg) : null,
    dailyMax: row.daily_max != null ? Number(row.daily_max) : null,
  };

  const isToday = date === new Date().toISOString().split('T')[0];
  cache.set(cacheKey, result, isToday ? CACHE_TTL.EVOLUTION : CACHE_TTL.RIDE_STATS);
  return result;
}

// ─── HEATMAP DE UMA ATRAÇÃO AO LONGO DE VÁRIOS DIAS ──────────────────────────

export async function getRideHeatmapHistory(
  parkId: number,
  timezone: string,
  rideName: string,
  days: number,
  intervalMinutes: number
): Promise<RideHeatmapHistoryPoint[]> {
  const cacheKey = `ride_heatmap_history:${parkId}:${rideName}:${days}:${intervalMinutes}`;
  const cached = cache.get<RideHeatmapHistoryPoint[]>(cacheKey);
  if (cached) return cached;

  const query = `
    WITH dados_indexados AS (
      SELECT
        DATE(timestamp_utc, @timezone) as data_local,
        wait_time,
        EXTRACT(HOUR   FROM DATETIME(timestamp_utc, @timezone)) as hora,
        EXTRACT(MINUTE FROM DATETIME(timestamp_utc, @timezone)) as minuto
      FROM \`${DATASET}\`
      WHERE park_id = @parkId
        AND (${RIDE_NAME_EXPR}) = @rideName
        AND timestamp_utc >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days + 1 DAY)
        AND DATE(timestamp_utc, @timezone) >= DATE_SUB(CURRENT_DATE(@timezone), INTERVAL @days DAY)
        AND EXTRACT(HOUR FROM DATETIME(timestamp_utc, @timezone)) BETWEEN 8 AND 22
    )
    SELECT
      data_local,
      hora,
      DIV(minuto, @bloco) * @bloco as minuto_bloco,
      ROUND(AVG(wait_time), 0) as wait_time_medio
    FROM dados_indexados
    GROUP BY data_local, hora, minuto_bloco
    ORDER BY data_local, hora, minuto_bloco
  `;

  const [rows] = await bq.query({
    query,
    params: { parkId, timezone, rideName, days, bloco: intervalMinutes },
  });

  const result: RideHeatmapHistoryPoint[] = (rows as any[]).map(r => ({
    data_local: typeof r.data_local === 'object' ? r.data_local.value : String(r.data_local),
    hora: Number(r.hora),
    minuto_bloco: Number(r.minuto_bloco),
    wait_time_medio: Number(r.wait_time_medio),
    label_tempo: String(r.hora).padStart(2, '0') + ':' + String(r.minuto_bloco).padStart(2, '0'),
  }));

  cache.set(cacheKey, result, CACHE_TTL.RIDE_HEATMAP_HISTORY);
  return result;
}

// ─── PERFIL HISTÓRICO CONTÍNUO DE UMA ATRAÇÃO ────────────────────────────────
// Média histórica por bloco de tempo (não por hora cheia) — usado pra desenhar
// a linha de "média histórica" no mesmo eixo contínuo do gráfico do dia, em vez
// de um degrau por hora.

export async function getRideHistoricalProfile(
  parkId: number,
  rideName: string,
  intervalMinutes: number
): Promise<RideHistoricalProfilePoint[]> {
  const cacheKey = `ride_historical_profile:${parkId}:${rideName}:${intervalMinutes}`;
  const cached = cache.get<RideHistoricalProfilePoint[]>(cacheKey);
  if (cached) return cached;

  const result = await queryHistoricalProfile(
    'n_positivos', 'soma_positivos',
    'park_id = @parkId AND ride_name = @rideName',
    { parkId, rideName, bloco: intervalMinutes },
  );
  cache.set(cacheKey, result, CACHE_TTL.RIDE_STATS);
  return result;
}

/**
 * Média histórica por bloco de `bloco` minutos, a partir dos blocos de 5 min
 * do agregado. Os intervalos aceitos (5/10/15/30/60) são múltiplos de 5, então
 * reagrupar somas e contagens dá exatamente a mesma média que a tabela bruta.
 */
async function queryHistoricalProfile(
  countColumn: 'n_validos' | 'n_positivos',
  sumColumn: 'soma_validos' | 'soma_positivos',
  where: string,
  params: Record<string, unknown> & { bloco: number },
): Promise<RideHistoricalProfilePoint[]> {
  const query = `
    SELECT
      hora,
      DIV(minuto_bloco, @bloco) * @bloco as bloco,
      ROUND(SUM(${sumColumn}) / SUM(${countColumn}), 0) as wait_time_medio
    FROM \`${AGG_PROFILE_TABLE}\`
    WHERE ${where}
      AND hora BETWEEN ${PROFILE_HOURS.from} AND ${PROFILE_HOURS.to}
    GROUP BY hora, bloco
    HAVING SUM(${countColumn}) > 0
    ORDER BY hora, bloco
  `;

  const [rows] = await bq.query({ query, params });
  return (rows as any[]).map(r => ({
    hora: Number(r.hora),
    minuto_bloco: Number(r.bloco),
    wait_time_medio: Number(r.wait_time_medio),
    label_tempo: String(r.hora).padStart(2, '0') + ':' + String(r.bloco).padStart(2, '0'),
  }));
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
      AND ${operatingDayWhereClause(timezone, date)}
    GROUP BY hora, minuto
    ORDER BY ${operatingDayOrderBy('minuto')}
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

// ─── PERFIL HISTÓRICO CONTÍNUO DO PARQUE (todas as atrações) ─────────────────
// Contraparte histórica de `getDailyEvolution` — mesma agregação (sem filtrar
// wait_time > 0, pra ficar comparável com a evolução de um dia específico),
// mas por bloco de tempo e com todos os dias agregados.
export async function getParkHistoricalProfile(
  parkId: number,
  intervalMinutes: number
): Promise<RideHistoricalProfilePoint[]> {
  const cacheKey = `park_historical_profile:${parkId}:${intervalMinutes}`;
  const cached = cache.get<RideHistoricalProfilePoint[]>(cacheKey);
  if (cached) return cached;

  const result = await queryHistoricalProfile(
    'n_validos', 'soma_validos',
    'park_id = @parkId',
    { parkId, bloco: intervalMinutes },
  );
  cache.set(cacheKey, result, CACHE_TTL.RIDE_STATS);
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
        AND timestamp_utc >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${LIVE_LOOKBACK_DAYS} DAY)
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
      AND timestamp_utc >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${LIVE_LOOKBACK_DAYS} DAY)
      AND timestamp_utc = ultimo_registro.max_ts
    ORDER BY name
  `;

  const [rows] = await bq.query({ query });

  // Como os dados já vêm tratados e filtrados pelo seu Job de coleta no BigQuery,
  // basta tipar e estruturar o retorno esperado pela rota.
  const result = rows
    .map(r => ({
      id: Number(r.id),
      name: String(r.name),
      is_open: Boolean(r.is_open),
      wait_time: Number(r.wait_time)
    }))
    .filter(ride => {
      if (parkId === 6) {
        return MAGIC_KINGDOM_MECHANICAL_IDS.includes(ride.id);
      }
      if (parkId === 5) {
        return EPCOT_MECHANICAL_IDS.includes(ride.id);
      }
      if (parkId === 7) {
        return HOLLYWOOD_STUDIOS_MECHANICAL_IDS.includes(ride.id);
      }
      if (parkId === 8) {
        return ANIMAL_KINGDOM_MECHANICAL_IDS.includes(ride.id);
      }

      return true;
    });
  // Salva no cache de curta duração (2 minutos)
  cache.set(cacheKey, result, CACHE_TTL.EVOLUTION);
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
      AND timestamp_utc >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${lookbackDays + 1} DAY)
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

  if (!FORECAST_SERVICE_URL) {
    throw new Error('Serviço de previsão não configurado (FORECAST_SERVICE_URL).');
  }

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

// ─── HORÁRIOS DE SHOWS (só BCW) ───────────────────────────────────────────────
// A tabela é append-only (cada coleta das 10h/12h grava um snapshot) e o
// próprio coletor já deduplica antes de gravar -- mas o SELECT DISTINCT aqui
// é uma segurança barata a mais contra qualquer linha duplicada que já
// existisse antes dessa dedução ter sido corrigida na coleta.

export async function getShowsSchedule(
  parkId: number,
  date: string
): Promise<ShowSession[]> {
  const cacheKey = `shows:${parkId}:${date}`;
  const cached = cache.get<ShowSession[]>(cacheKey);
  if (cached) return cached;

  const query = `
    SELECT DISTINCT atracao_id, nome, periodo_de, periodo_ate
    FROM \`${SHOWS_TABLE}\`
    WHERE park_id = @parkId AND data_local = @date
    ORDER BY periodo_de
  `;

  const [rows] = await bq.query({ query, params: { parkId, date } });
  const result: ShowSession[] = rows.map((r: any) => ({
    atracao_id: Number(r.atracao_id),
    nome: String(r.nome),
    periodo_de: String(r.periodo_de.value ?? r.periodo_de),
    periodo_ate: String(r.periodo_ate.value ?? r.periodo_ate),
  }));

  cache.set(cacheKey, result, CACHE_TTL.SHOWS);
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