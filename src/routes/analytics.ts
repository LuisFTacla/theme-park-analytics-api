import { Router } from 'express';
import geoip from 'geoip-lite';
import { bq } from '../services/bigquery.service'; // Ajuste o nome da variável se lá for diferente (ex: bigquery)

const router = Router();
const DATASET_NAME = 'theme_park_queues'; // Dataset que acabamos de criar

router.post('/track', async (req, res) => {
  try {
    const { eventType, parkId, parkName, tabName, sessionId } = req.body;
    
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const cleanIp = Array.isArray(ip) ? ip[0] : ip?.split(',')[0].trim();
    const geo = cleanIp ? geoip.lookup(cleanIp) : null;

    const row = {
      timestamp: new Date().toISOString(),
      event_type: eventType,
      park_id: parkId || null,
      park_name: parkName || null,
      tab_name: tabName || null,
      country: geo?.country || 'Unknown',
      city: geo?.city || 'Unknown',
      session_id: sessionId || 'anonymous',
    };

    // Insere no BigQuery (agora descomentado e funcional)
    await bq.dataset(DATASET_NAME).table('user_events').insert([row]);

    return res.status(204).send();
  } catch (error) {
    console.error('Erro ao registrar analytics:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;