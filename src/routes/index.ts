// src/routes/index.ts

import { Router, Request, Response, NextFunction } from 'express';
import { TZ_MAP } from '../types';
import {
  getAvailableParks,
  getHourlyAverages,
  getDailyAverages,
  getDailyHeatmapData,
  getDailyEvolution,
  getLiveFromBigQuery,
  getRawHistoricalData,
} from '../services/bigquery.service';

const router = Router();

// Helper para respostas de sucesso
const ok = <T>(res: Response, data: T) =>
  res.json({ data, timestamp: new Date().toISOString() });

// Helper para extrair e validar o parkId
function parseParkId(req: Request, res: Response): number | null {
  const id = parseInt(req.params.parkId, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: 'INVALID_PARAM', message: 'parkId deve ser um número inteiro.' });
    return null;
  }
  return id;
}

// ─── GET /parks ───────────────────────────────────────────────────────────────
router.get('/parks', async (_req, res, next) => {
  try {
    const parks = await getAvailableParks();
    ok(res, parks);
  } catch (err) {
    next(err);
  }
});

// ─── GET /parks/:parkId/timezone ──────────────────────────────────────────────
router.get('/parks/:parkId/timezone', (req, res) => {
  const id = parseParkId(req, res);
  if (id === null) return;
  ok(res, { timezone: TZ_MAP[id] ?? 'UTC' });
});

// ─── GET /parks/:parkId/hourly ────────────────────────────────────────────────
router.get('/parks/:parkId/hourly', async (req, res, next) => {
  const id = parseParkId(req, res);
  if (id === null) return;
  try {
    const tz = TZ_MAP[id] ?? 'UTC';
    const data = await getHourlyAverages(id, tz);
    ok(res, data);
  } catch (err) {
    next(err);
  }
});

// ─── GET /parks/:parkId/calendar ──────────────────────────────────────────────
router.get('/parks/:parkId/calendar', async (req, res, next) => {
  const id = parseParkId(req, res);
  if (id === null) return;
  try {
    const tz = TZ_MAP[id] ?? 'UTC';
    const result = await getDailyAverages(id, tz);
    ok(res, result);
  } catch (err) {
    next(err);
  }
});

// ─── GET /parks/:parkId/heatmap?date=YYYY-MM-DD&interval=60 ──────────────────
router.get('/parks/:parkId/heatmap', async (req, res, next) => {
  const id = parseParkId(req, res);
  if (id === null) return;

  const date = req.query.date as string;
  const interval = parseInt(req.query.interval as string, 10) || 60;

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'INVALID_PARAM', message: 'Parâmetro date deve estar no formato YYYY-MM-DD.' });
    return;
  }
  if (![15, 30, 60].includes(interval)) {
    res.status(400).json({ error: 'INVALID_PARAM', message: 'interval deve ser 15, 30 ou 60.' });
    return;
  }

  try {
    const tz = TZ_MAP[id] ?? 'UTC';
    const data = await getDailyHeatmapData(id, tz, date, interval);
    ok(res, data);
  } catch (err) {
    next(err);
  }
});

// ─── GET /parks/:parkId/evolution?date=YYYY-MM-DD ─────────────────────────────
router.get('/parks/:parkId/evolution', async (req, res, next) => {
  const id = parseParkId(req, res);
  if (id === null) return;

  const date = req.query.date as string;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'INVALID_PARAM', message: 'Parâmetro date deve estar no formato YYYY-MM-DD.' });
    return;
  }

  try {
    const tz = TZ_MAP[id] ?? 'UTC';
    const data = await getDailyEvolution(id, tz, date);
    ok(res, data);
  } catch (err) {
    next(err);
  }
});

// ─── GET /parks/:parkId/live ──────────────────────────────────────────────────
router.get('/parks/:parkId/live', async (req, res, next) => {
  const id = parseParkId(req, res);
  if (id === null) return;
  try {
    const data = await getLiveFromBigQuery(id);
    ok(res, data);
  } catch (err) {
    next(err);
  }
});

// ─── GET /parks/:parkId/raw ──────────────────────────────────────────────────
router.get('/parks/:parkId/raw', async (req, res, next) => {
  const id = parseParkId(req, res);
  if (id === null) return;

  // Captura os query parameters opcionais
  const queryRideId = req.query.rideId as string;
  const queryYear = req.query.year as string;

  let rideId: number | undefined;
  let year: number | undefined;

  // Validação do rideId caso ele seja enviado
  if (queryRideId) {
    rideId = parseInt(queryRideId, 10);
    if (isNaN(rideId)) {
      res.status(400).json({ error: 'INVALID_PARAM', message: 'rideId deve ser um número inteiro.' });
      return;
    }
  }

  // Validação do year caso ele seja enviado
  if (queryYear) {
    year = parseInt(queryYear, 10);
    if (isNaN(year) || year < 2000 || year > 2100) {
      res.status(400).json({ error: 'INVALID_PARAM', message: 'year deve ser um ano válido com 4 dígitos.' });
      return;
    }
  }

  try {
    const tz = TZ_MAP[id] ?? 'UTC';
    const data = await getRawHistoricalData(id, tz, rideId, year);
    ok(res, data);
  } catch (err) {
    next(err);
  }
});

export default router;
