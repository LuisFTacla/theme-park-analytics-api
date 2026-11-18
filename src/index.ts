import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import routes from './routes';
import analyticsRouter from './routes/analytics';

const app = express();
const PORT = process.env.PORT || 3001;

// ─── CONFIGURAÇÃO DE PROXY (Essencial para nuvem) ─────────────────────────────
app.set('trust proxy', 1);

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Só o front-end pode chamar a API pelo navegador — sem isso, qualquer site
// consegue disparar consultas (pagas) no BigQuery. Aceita várias origens
// separadas por vírgula. Requisições sem Origin (curl, proxy do Vite em dev)
// não são afetadas por CORS; essas ficam a cargo do rate limit abaixo.
const allowedOrigins = (process.env.ALLOWED_ORIGIN ?? '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

if (!allowedOrigins.length) {
  console.warn('[CORS] ALLOWED_ORIGIN não definido — API aberta para qualquer origem.');
}

app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : true }));

// ─── RATE LIMIT ───────────────────────────────────────────────────────────────
// Uma visita à Home custa ~11 requests e cada parque ~7; 120/min dá folga pra
// navegação normal e pra várias pessoas atrás do mesmo IP (NAT de 4G, empresa).
// Repetições caem no cache do servidor e não chegam ao BigQuery.
app.use(rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 120,            // 120 requests por IP por minuto
  standardHeaders: true,
  legacyHeaders: false,
}));

app.use(express.json());

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── ANALYTICS ────────────────────────────────────────────────────────────────
app.use('/api/analytics', analyticsRouter);

// ─── ROTAS DA API ─────────────────────────────────────────────────────────────
app.use('/api', routes);

// ─── TRATAMENTO DE ERROS ──────────────────────────────────────────────────────
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[API Error]', err.message);
  res.status(500).json({
    error: 'INTERNAL_ERROR',
    message: 'Erro interno do servidor. Tente novamente mais tarde.',
  });
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🎢 Theme Park API rodando em http://localhost:${PORT}`);
});
