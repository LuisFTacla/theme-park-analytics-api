// src/index.ts

import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import routes from './routes';

const app = express();
const PORT = process.env.PORT || 3001;

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Em produção, restrinja origins ao seu domínio Vercel
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN ?? '*',
  methods: ['GET'],
}));

// ─── RATE LIMIT ───────────────────────────────────────────────────────────────
app.use(rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 60,             // 60 requests por IP por minuto
  standardHeaders: true,
  legacyHeaders: false,
}));

app.use(express.json());

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

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
