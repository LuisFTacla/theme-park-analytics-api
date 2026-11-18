import { Router } from 'express';
import geoip from 'geoip-lite';
import { bq } from '../services/bigquery.service';

const router = Router();
const DATASET_NAME = 'theme_park_queues';

router.post('/track', async (req, res) => {
  try {
    const { eventType, parkId, parkName, tabName, sessionId } = req.body;
    
    // Captura o IP real considerando o trust proxy do Render
    const ipHeader = req.headers['x-forwarded-for'];
    const cleanIp = Array.isArray(ipHeader) 
      ? ipHeader[0] 
      : (ipHeader ? ipHeader.split(',')[0].trim() : req.socket.remoteAddress);

    const geo = cleanIp ? geoip.lookup(cleanIp) : null;

    // Se o geoip encontrar a cidade, usa ela. Se não, tenta usar a região (estado/UF, ex: SP, PR). 
    // Se nenhum dos dois existir, retorna 'Unknown'.
    const city = geo?.city || geo?.region || 'Unknown';
    const country = geo?.country || 'Unknown';

    const row = {
      timestamp: new Date().toISOString(),
      event_type: eventType,
      park_id: parkId || null,
      park_name: parkName || null,
      tab_name: tabName || null,
      country,
      city,
      session_id: sessionId || 'anonymous',
    };

    // Insere no BigQuery
    await bq.dataset(DATASET_NAME).table('user_events').insert([row]);

    return res.status(204).send();
  } catch (error) {
    console.error('Erro ao registrar analytics:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;