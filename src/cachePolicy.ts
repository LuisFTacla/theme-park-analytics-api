// Cabeçalho Cache-Control das respostas de sucesso.
//
// O front chama a API pelo próprio domínio na Vercel (rewrite /api/* -> Render),
// e o CDN da Vercel guarda as respostas por `s-maxage`. Assim a maioria das
// visitas é servida pelo CDN sem acordar a API (que hiberna no plano gratuito
// do Render) nem consultar o BigQuery. `stale-while-revalidate` deixa o CDN
// entregar a cópia antiga na hora enquanto busca a nova em segundo plano.
//
// `max-age` (cache do navegador) fica curto: quem recarrega a página não deve
// ficar preso numa cópia local antiga.

import { Request } from 'express';
import { TZ_MAP } from './types';

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface CacheTimes {
  cdn: number;
  stale: number;
}

const LIVE: CacheTimes = { cdn: MINUTE, stale: MINUTE };
const RECENT: CacheTimes = { cdn: 2 * MINUTE, stale: 5 * MINUTE };
/** Agregados que incluem o dia de hoje (calendário, heatmap dos últimos dias). */
const INCLUDES_TODAY: CacheTimes = { cdn: 10 * MINUTE, stale: HOUR };
/** Perfis históricos: as tabelas agregadas só mudam uma vez por dia. */
const HISTORICAL: CacheTimes = { cdn: 6 * HOUR, stale: DAY };
/** Dias já encerrados não mudam mais. */
const PAST_DAY: CacheTimes = { cdn: DAY, stale: 7 * DAY };
const STATIC: CacheTimes = { cdn: DAY, stale: 7 * DAY };
const DEFAULT: CacheTimes = { cdn: 5 * MINUTE, stale: HOUR };

/** Rotas cuja resposta depende de `?date=` (dia passado vs. dia em andamento). */
const DATED_ROUTES = new Set([
  '/parks/:parkId/heatmap',
  '/parks/:parkId/evolution',
  '/parks/:parkId/shows',
  '/parks/:parkId/rides/stats',
]);

const FIXED_ROUTES: Record<string, CacheTimes> = {
  '/parks': STATIC,
  '/parks/:parkId/timezone': STATIC,
  '/parks/:parkId/live': LIVE,
  '/parks/:parkId/calendar': INCLUDES_TODAY,
  '/parks/:parkId/rides/heatmap-history': INCLUDES_TODAY,
  '/parks/:parkId/historical-profile': HISTORICAL,
  '/parks/:parkId/rides/historical-profile': HISTORICAL,
  '/parks/:parkId/hourly': HISTORICAL,
  '/parks/:parkId/forecast': HISTORICAL,
  '/parks/:parkId/backtest': STATIC,
};

/** Data local (YYYY-MM-DD) de ontem no fuso do parque. */
function localYesterday(timezone: string): string {
  const yesterday = new Date(Date.now() - DAY * 1000);
  return yesterday.toLocaleDateString('en-CA', { timeZone: timezone });
}

function cacheTimesFor(req: Request): CacheTimes {
  const route: string | undefined = req.route?.path;
  if (!route) return DEFAULT;

  if (DATED_ROUTES.has(route)) {
    const date = String(req.query.date ?? '');
    const timezone = TZ_MAP[Number(req.params.parkId)] ?? 'UTC';
    // Ontem ainda pode receber a cauda da madrugada (dia operacional vai até
    // 4h), então só trata como encerrado o que for anterior a ontem.
    return date && date < localYesterday(timezone) ? PAST_DAY : RECENT;
  }

  return FIXED_ROUTES[route] ?? DEFAULT;
}

export function cacheControlFor(req: Request): string {
  const { cdn, stale } = cacheTimesFor(req);
  return `public, max-age=${MINUTE}, s-maxage=${cdn}, stale-while-revalidate=${stale}`;
}
