// src/types/index.ts

export interface Park {
  park_id: number;
  park_name: string;
}

export interface HourlyAverage {
  name: string;
  hora_cheia: number;
  wait_time: number;
}

export interface DailyAverage {
  data_local: string;
  ano_registro: number;
  wait_time: number;
  year: number;
  month: number;
  day: number;
  day_of_week: string;
  week_of_year: number;
  is_forecast?: boolean; // true quando o dia vem do modelo de previsão, não do histórico real
}

export interface HeatmapDataPoint {
  name: string;
  hora: number;
  minuto_bloco: number;
  wait_time_medio: number;
  label_tempo?: string;
}

export interface LiveRide {
  id: number;
  name: string;
  is_open: boolean;
  wait_time: number;
}

export interface DailyEvolutionPoint {
  horario: string;
  wait_time: number;
}

export interface HistoricalRawData {
  timestamp_utc: string;
  data_local: string;
  ride_id: number;
  name: string;
  wait_time: number;
  is_open?: boolean;
}

// ─── Previsão (forecast) ────────────────────────────────────────────────────

// Histórico diário por atração — input do microsserviço de previsão
export interface DailyRideAverage {
  name: string;
  data_local: string; // YYYY-MM-DD
  avg_wait_time: number;
}

// Um ponto previsto, devolvido pelo microsserviço Python
export interface ForecastPoint {
  name: string;
  data_local: string; // YYYY-MM-DD
  pred_wait_time: number;
}

export interface ForecastResponse {
  previsoes: ForecastPoint[];
  horizonte_minimo_dias: number;
  mae_esperado_val: number;
}

// ─── Validação / Backtest ───────────────────────────────────────────────────

export interface BacktestPoint {
  data_local: string; // YYYY-MM-DD
  name: string;
  wait_time_real: number;
  wait_time_previsto: number;
  mes_referencia: string; // YYYY-MM
  abs_erro: number;
}

export interface ApiResponse<T> {
  data: T;
  cached?: boolean;
  timestamp: string;
}

export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
}

// Mapa de fusos horários por park_id
export const TZ_MAP: Record<number, string> = {
  319: 'America/Sao_Paulo',
  2:   'Europe/London',
  4:   'Europe/Paris',
  5:   'America/New_York',
  6:   'America/New_York',
  7:   'America/New_York',
  8:   'America/New_York',
  9:   'Europe/Paris',
  15:  'America/New_York',
  16:  'America/Los_Angeles',
  17:  'America/Los_Angeles',
  21:  'America/New_York',
  24:  'America/New_York',
  28:  'Europe/Paris',
  32:  'America/Los_Angeles',
  61:  'America/Los_Angeles',
  64:  'America/New_York',
  65:  'America/New_York',
  66:  'America/Los_Angeles',
  334: 'America/New_York',
};

// IDs das atrações mecânicas do BCW (park_id 319)
export const BCW_MECHANICAL_IDS = [
  11329, 11366, 11332, 11340, 11330, 11328, 11373, 11326,
  13872, 11368, 11367, 11444, 11358, 12325, 12326, 11327,
  11335, 11336, 11338, 11344, 11459, 11334, 15407, 11331,
];